/**
 * iec60870-101master/app.js
 * IEC 60870-5-101 master (unbalanced) — плагин IntraSCADA
 *
 * Работает с C++ аддоном ih-lib60870-node (cs101_master_unbalanced.cpp):
 *   master.connect({ portName, baudRate, clientID, params: {...} })
 *   master.disconnect()
 *   master.addSlave(addr)              // динамическое добавление
 *   master.pollSlave(addr)             // Class 2 poll (триггер очереди)
 *   master.requestClass1(addr)         // синоним pollSlave
 *   master.sendInterrogation(sa, qoi)  // нативный C_IC_NA_1 (COT=6)
 *   master.sendCommands([{typeId, ioa, value, select?}], sa)
 *
 * События от C++:
 *   opened / busy / closed / failed / error / reconnecting — per slave
 *   initDone — после первичной инициализации всех slaves
 *   interrogationActivation / interrogationTerminated / interrogationData
 *   commandActivationCon / commandActivationTerm / commandUnknown*
 *
 * Данные процессов: массив [{clientID, typeId, asdu, ioa, val, quality, slaveAddress, timestamp?}]
 */

const util = require('util');
const { IEC101MasterUnbalanced } = require('ih-lib60870-node');
const Scanner = require('./lib/scanner');

module.exports = async function (plugin) {
  // ====== Состояние ======
  let master = null;
  let channels = await plugin.channels.get();
  const params = plugin.params.data;
  const scanner = new Scanner(plugin);

  let channelsObj = groupBySlave(channels);
  let slaveAddresses = Object.keys(channelsObj).map(Number)
    .filter(n => !isNaN(n)).sort((a, b) => a - b);

  let sendArr = [];
  let T1 = null;
  let pollTimer = null;
  let interrogTimer = null;
  let timeSyncTimer = null;
  let connected = false;
  let pollIndex = 0;

  let masterStarted = false;
  let pendingConnect = false;
  const onlineSlaves = new Set();

  plugin.log('101master started. Slave addresses: ' + util.inspect(slaveAddresses), 2);
  plugin.log('params = ' + util.inspect(params), 2);
  plugin.log('channelsObj = ' + util.inspect(channelsObj), 2);

  // ====== Буферизация отправки ======
  sendNext();
  function sendNext() {
    if (sendArr.length > 0) {
      plugin.sendData(sendArr);
      sendArr = [];
    }
    T1 = setTimeout(sendNext, params.buffertime || 500);
  }

  // ====== Создание master'а ======
  master = new IEC101MasterUnbalanced((event, data) => {
    if (event !== 'data') return;

    try {
      if (Array.isArray(data)) {
        handleIncomingData(data);
        return;
      }
      if (data && data.event) {
        handleControlEvent(data);
      }
    } catch (e) {
      plugin.log('CS101 callback error: ' + e.message + '\n' + (e.stack || ''), 0);
    }
  });

  // ====== Обработка control-событий ======
  function handleControlEvent(ev) {
    plugin.log('CONTROL EVENT: ' + util.inspect(ev), 2);

    const slaveAddr = Number(ev.slaveAddress);

    switch (ev.event) {
      // ---- Канальный уровень (per slave) ----
      case 'opened':
        if (ev.reason === 'link layer available' && !isNaN(slaveAddr)) {
          onSlaveAvailable(slaveAddr);
        } else {
          plugin.log(`Link OPENED (${ev.reason}) for slave ${ev.slaveAddress}`, 2);
        }
        break;

      case 'closed':
        if (!isNaN(slaveAddr)) onSlaveClosed(slaveAddr);
        break;

      case 'busy':
        plugin.log(`Slave ${slaveAddr}: link layer busy`, 2);
        break;

      case 'failed':
      case 'error':
        plugin.log(`Slave ${slaveAddr}: ${ev.reason}`, 1);
        if (!isNaN(slaveAddr)) onSlaveClosed(slaveAddr);
        break;

      case 'reconnecting':
        plugin.log(`Reconnecting: ${ev.reason}`, 1);
        break;

      // ---- Инициализация master'а завершена ----
      case 'initDone':
        onMasterInitDone();
        break;

      // ---- Общий опрос ----
      case 'interrogationActivation':
        plugin.log(`IC ACT_CON slave ${slaveAddr} (COT=${ev.cot})`, 2);
        break;
      case 'interrogationTerminated':
        plugin.log(`IC ACT_TERM slave ${slaveAddr} (COT=${ev.cot})`, 2);
        break;
      case 'interrogationData':
        plugin.log(`IC data slave ${slaveAddr} (COT=${ev.cot})`, 2);
        break;

      // ---- Подтверждения команд ----
      case 'commandActivationCon':
        if (ev.pn) {
          plugin.log(`Command REJECTED (P/N=1) typeID=${ev.typeId} slave=${slaveAddr}`, 1);
        } else {
          plugin.log(`Command ACT_CON typeID=${ev.typeId} slave=${slaveAddr}`, 2);
        }
        break;

      case 'commandActivationTerm':
        plugin.log(`Command ACT_TERM typeID=${ev.typeId} slave=${slaveAddr}`, 2);
        break;

      case 'commandUnknownType':
        plugin.log(`Command UNKNOWN_TYPE typeID=${ev.typeId} slave=${slaveAddr}`, 1);
        break;

      case 'commandUnknownCA':
        plugin.log(`Command UNKNOWN_CA slave=${slaveAddr}`, 1);
        break;

      case 'commandUnknownIOA':
        plugin.log(`Command UNKNOWN_IOA slave=${slaveAddr}`, 1);
        break;

      case 'commandDeactivationCon':
      case 'commandDeactivationTerm':
      case 'commandUnknown':
        plugin.log(`Command event: ${ev.event} typeID=${ev.typeId} slave=${slaveAddr}`, 2);
        break;

      default:
        plugin.log('Unhandled event: ' + util.inspect(ev), 3);
    }
  }

  // ====== Инициализация master'а завершена ======
  function onMasterInitDone() {
    if (masterStarted) {
      plugin.log('Master already started, skip re-init.', 2);
      return;
    }
    masterStarted = true;
    connected = true;
    plugin.log('Master init DONE, launching polling loops.', 1);

    startPolling();
    startInterrogationTimer();
    startTimeSync();
  }

  // ====== Slave доступен ======
  function onSlaveAvailable(slaveAddr) {
    plugin.log(`Slave ${slaveAddr} AVAILABLE.`, 1);
    onlineSlaves.add(slaveAddr);

    const bucket = channelsObj[slaveAddr];
    if (bucket && bucket.connectionStatusId) {
      sendArr.push({ id: bucket.connectionStatusId, value: 1, ts: Date.now() });
    }

    // Общий опрос после короткой паузы — канал успевает стать готов
    setTimeout(() => sendInterrogation(slaveAddr), 500);
  }

  // ====== Slave закрылся ======
  function onSlaveClosed(slaveAddr) {
    plugin.log(`Slave ${slaveAddr} CLOSED.`, 1);
    onlineSlaves.delete(slaveAddr);

    const bucket = channelsObj[slaveAddr];
    if (bucket && bucket.connectionStatusId) {
      sendArr.push({ id: bucket.connectionStatusId, value: 0, ts: Date.now() });
    }
  }

  // ====== Приём данных ======
  function handleIncomingData(arr) {
    arr.forEach(item => {
      if (scanner.status > 0) scanner.sendData(item);

      const slaveAddr = Number(item.slaveAddress);
      const bucket = channelsObj[slaveAddr];
      if (!bucket) return;

      const addrArr = bucket.objects[String(item.ioa)];
      if (!addrArr || addrArr.length === 0) return;

      addrArr.forEach(addr => {
        const obj = {};
        if (addr.bit) {
          obj.value = (item.val & Math.pow(2, Number(addr.offset))) ? 1 : 0;
        } else {
          obj.value = item.val;
        }

        if (item.timestamp != undefined) {
          obj.ts = applyTimezone(item.timestamp, addr.tzondevice);
        } else {
          obj.ts = Date.now();
        }
        obj.id = addr.id;
        obj.chstatus = item.quality;
        obj.quality = item.quality;
        obj.title = addr.title;
        obj.parentname = addr.parentname;
        sendArr.push(obj);
      });
    });
  }

  // ====== Часовой пояс ======
  function applyTimezone(ts, tz) {
    if (!tz) return ts;
    let s = String(tz).trim();
    if (s.startsWith('UTC')) s = s.slice(3);
    const hours = Number(s);
    if (isNaN(hours)) return ts;
    return ts + hours * (-3600000);
  }

  // ====== Остановка таймеров ======
  function stopTimers() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (interrogTimer) { clearInterval(interrogTimer); interrogTimer = null; }
    if (timeSyncTimer) { clearTimeout(timeSyncTimer); timeSyncTimer = null; }
  }

  // ====== Циклический опрос (round-robin) ======
  function startPolling() {
    const gap = Number(params.polldelay || 100);
    const step = () => {
      if (!connected || slaveAddresses.length === 0) {
        pollTimer = setTimeout(step, 1000);
        return;
      }
      const addr = slaveAddresses[pollIndex % slaveAddresses.length];
      pollIndex = (pollIndex + 1) % slaveAddresses.length;
      try {
        master.pollSlave(addr);
      } catch (e) {
        plugin.log(`pollSlave(${addr}) error: ${e.message}`, 3);
      }
      pollTimer = setTimeout(step, gap);
    };
    pollTimer = setTimeout(step, gap);
  }

  // ====== Общий опрос ======
  function sendInterrogation(slaveAddr) {
    try {
      let ok;
      if (typeof master.sendInterrogation === 'function') {
        ok = master.sendInterrogation(slaveAddr, 20);
      } else {
        ok = master.sendCommands(
          [{ typeId: 100, ioa: 0, value: 20 }],
          slaveAddr
        );
      }
      plugin.log(`Interrogation -> slave ${slaveAddr}: ${ok}`, 2);
    } catch (e) {
      plugin.log(`Interrogation error (slave ${slaveAddr}): ${e.message}`, 2);
    }
  }

  function startInterrogationTimer() {
    const periodMin = Number(params.interrogationtimer || 15);
    interrogTimer = setInterval(() => {
      slaveAddresses.forEach(sendInterrogation);
    }, periodMin * 60 * 1000);
  }

  // ====== Синхронизация времени (C_CS_NA_1) ======
  function startTimeSync() {
    const periodMin = Number(params.timesynctimer || 30);
    const doSync = () => {
      const now = Date.now();
      slaveAddresses.forEach(addr => {
        const bucket = channelsObj[addr];
        if (!bucket || !bucket.timesync) return;
        try {
          master.sendCommands([{ typeId: 103, ioa: 0, value: now }], addr);
          plugin.log(`TimeSync -> slave ${addr}: ${new Date(now).toISOString()}`, 2);
        } catch (e) {
          plugin.log(`TimeSync error (slave ${addr}): ${e.message}`, 2);
        }
      });
      timeSyncTimer = setTimeout(doSync, periodMin * 60 * 1000);
    };
    // Первую синхронизацию выполняем сразу
    doSync();
  }

  // ====== Подключение ======
  function tryConnect() {
    if (masterStarted || connected) return;
    if (slaveAddresses.length === 0) {
      pendingConnect = true;
      plugin.log('No slaves configured, connect deferred.', 2);
      return;
    }

    const firstNode = channelsObj[slaveAddresses[0]] || {};

    try {
      plugin.log(`Connect: ${params.portName} @ ${params.baudRate}`, 1);
      plugin.log(
        `ASDU format: TypeId=${params.sizeOfTypeId || 1}, VSQ=${params.sizeOfVSQ || 1}, ` +
        `COT=${params.sizeOfCOT || 1}, CA=${params.sizeOfCA || 1}, ` +
        `IOA=${params.sizeOfIOA || 3}, maxASDU=${params.maxSizeOfASDU || 249}`,
        2
      );

      master.connect({
        portName: params.portName,
        baudRate: Number(params.baudRate || 9600),
        clientID: params.clientID || ('iec101master_' + Date.now()),
        params: {
          linkAddress: Number(params.linkAddress != undefined ? params.linkAddress : 3),
          originatorAddress: Number(params.originatorAddress != undefined ? params.originatorAddress : 3),

          sizeOfTypeId:  Number(params.sizeOfTypeId  || 1),
          sizeOfVSQ:     Number(params.sizeOfVSQ     || 1),
          sizeOfCOT:     Number(params.sizeOfCOT     || 1),
          sizeOfCA:      Number(params.sizeOfCA      || 1),
          sizeOfIOA:     Number(params.sizeOfIOA     || 3),
          maxSizeOfASDU: Number(params.maxSizeOfASDU || 249),

          t0: Number(firstNode.paramt0 || 120),
          t1: Number(firstNode.paramt1 || 60),
          t2: Number(firstNode.paramt2 || 40),

          reconnectDelay: Number(params.reconnectDelay || 10),
          queueSize: Number(params.queueSize || 1000),
          slaveAddresses: slaveAddresses
        }
      });

      pendingConnect = false;
    } catch (e) {
      plugin.log('connect() error: ' + util.inspect(e), 1);
      plugin.exit(8, 'Failed to connect');
    }
  }

  tryConnect();

  // ====== Команды из SCADA ======
  plugin.onAct((message) => {
    plugin.log('onAct called: ' + util.inspect(message), 2);

    if (!connected || !master) {
      plugin.log('ACT ignored: master not connected', 2);
      return;
    }
    plugin.log('ACT data=' + util.inspect(message.data), 2);

    const bySlave = groupBySlave(message.data);

    Object.keys(bySlave).forEach(sa => {
      const bucket = bySlave[sa];
      const slaveAddr = Number(sa);
      if (isNaN(slaveAddr)) return;
      const writeArr = [];

      Object.keys(bucket.objects).forEach(k => {
        bucket.objects[k].forEach(item => {
          const ctype = Number(item.ioObjCtype);
          let val;

          // C_SC_NA(45), C_SC_TA(58) — bool
          if (ctype === 45 || ctype === 58) {
            val = (item.value == 1);
          } else {
            val = item.value;
          }

          const ioa = Number(item.cmdAdr != undefined ? item.cmdAdr : item.objAdr);
          const select = Number(item.selCmd || 0) ? true : false;

          // SELECT (если SBO) — сначала select=true
          if (select) {
            writeArr.push({
              id: item.id,
              typeId: ctype,
              ioa: ioa,
              value: val,
              select: true
            });
          }

          // EXECUTE (всегда) — select=false
          writeArr.push({
            id: item.id,
            typeId: ctype,
            ioa: ioa,
            value: val,
            select: false
          });
        });
      });

      if (writeArr.length === 0) return;

      try {
        writeArr.forEach(cmd => {
          plugin.log('writeCmd ' + util.inspect(cmd), 2);
          const ok = master.sendCommands([cmd], slaveAddr);
          plugin.log(ok ? 'Commands Success' : 'Commands Failed', 2);
        });
      } catch (e) {
        plugin.log('Write error: ' + util.inspect(e), 2);
      }
    });
  });

  // ====== Изменение каналов ======
  plugin.channels.onChange(async () => {
    channels = await plugin.channels.get();
    const newObj = groupBySlave(channels);
    const newAddrs = Object.keys(newObj).map(Number)
      .filter(n => !isNaN(n)).sort((a, b) => a - b);

    plugin.log('channels.onChange: new slaveAddresses=' + util.inspect(newAddrs), 2);

    if (!masterStarted && (pendingConnect || newAddrs.length > 0)) {
      channelsObj = newObj;
      slaveAddresses = newAddrs;
      tryConnect();
      return;
    }

    if (connected) {
      newAddrs.forEach(a => {
        if (!slaveAddresses.includes(a)) {
          try {
            master.addSlave(a);
            plugin.log(`Dynamically added slave ${a}`, 1);
          } catch (e) {
            plugin.log(`addSlave(${a}): ${e.message}`, 2);
          }
        }
      });
    }

    channelsObj = newObj;
    slaveAddresses = newAddrs;

    if (connected) slaveAddresses.forEach(sendInterrogation);
  });

  // ====== Сканирование ======
  plugin.onScan(scanObj => {
    if (!scanObj) return;

    if (scanObj.stop) {
      scanner.clients.clear();
      scanner.stop();
      return;
    }

    const sa = (scanObj.slaveAddress !== undefined) ? Number(scanObj.slaveAddress) : null;
    if (sa !== null && !isNaN(sa)) {
      scanner.request(master, sa, scanObj.uuid);
    } else {
      slaveAddresses.forEach(a => scanner.request(master, a, scanObj.uuid));
    }
  });

  // ====== Завершение ======
  async function terminate() {
    stopTimers();
    if (T1) clearTimeout(T1);
    try { if (master) master.disconnect(); } catch (e) { /* ignore */ }
    plugin.exit();
  }
  process.on('SIGTERM', terminate);
  process.on('SIGINT', terminate);
  if (plugin.onStop) plugin.onStop(terminate);

  // ====== Группировка каналов по slaveAddress ======
  function groupBySlave(array) {
    const map = new Map();

    array.forEach(item => {
      const sa = Number(item.slaveAddress);
      if (isNaN(sa)) return;

      const secondaryKey = String(item.objAdr);

      if (!map.has(sa)) {
        map.set(sa, {
          slaveAddress: sa,
          parentnodefolder: item.parentnodefolder,
          asduAddress: item.asduAddress,
          paramt0: item.paramt0 || 120,
          paramt1: item.paramt1 || 60,
          paramt2: item.paramt2 || 40,
          tzondevice: item.tzondevice || 'UTC+0',
          timesync: item.timesync || 0,
          connectionStatusId: item.syschan ? item.id : '',
          objects: new Map()
        });
      } else if (item.syschan) {
        const group = map.get(sa);
        if (!group.connectionStatusId && item.id) {
          group.connectionStatusId = item.id;
        }
      }

      if (!item.syschan) {
        const group = map.get(sa);
        if (!group.objects.has(secondaryKey)) group.objects.set(secondaryKey, []);
        group.objects.get(secondaryKey).push(item);
      }
    });

    return Object.fromEntries(
      Array.from(map.entries()).map(([k, v]) => [
        k,
        {
          slaveAddress: v.slaveAddress,
          parentnodefolder: v.parentnodefolder,
          asduAddress: v.asduAddress,
          paramt0: v.paramt0,
          paramt1: v.paramt1,
          paramt2: v.paramt2,
          tzondevice: v.tzondevice,
          timesync: v.timesync,
          connectionStatusId: v.connectionStatusId,
          objects: Object.fromEntries(v.objects)
        }
      ])
    );
  }

  plugin.log('=== app.js INITIALIZED ===', 0);
};