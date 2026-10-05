const { IEC101MasterUnbalanced } = require('../build/Release/addon_iec60870');
const util = require('util');

// ============================================================
// Конфигурация
// ============================================================
const CFG = {
    portName: '/dev/tty.usbserial-A505KXKT',
    baudRate: 9600,
    clientID: 'cs101_master_1',
    linkAddress: 3,

    
    slaveAddresses: [1, 2],

    // Размеры полей ASDU (под ваши устройства)
    addressLength: 1,
    sizeOfCA:      1,
    sizeOfCOT:     1,
    sizeOfIOA:     3,

    // Тайминги канального уровня
    t0: 120000,
    t1: 2000,          // ← было 60; на 9600 бод с 3-байтным IOA кадр длиннее
    t2: 500,           // ← было 40
    reconnectDelay: 10,
    queueSize: 1000,

    // Интервалы прикладного уровня
    pollIntervalMs:     1000,
    pollGapMs:          1500,
    interrogationMs:    300000,
    firstPollDelayMs:   2000,   // пауза после initDone
    firstInterrogationMs: 30000,
};

// ============================================================
// Состояние
// ============================================================
const onlineSlaves = new Set();
let pollStarted = false;

// ============================================================
// Master
// ============================================================
const master = new IEC101MasterUnbalanced((event, data) => {
    try {
        if (event !== 'data') return;

        // ----- Массив данных процесса (M_*) -----
        if (Array.isArray(data)) {
            if (data.length === 0) return;
            console.log(`Master: Data ${data.length} elements`);
            data.forEach(item => {
                console.log(
                    `  Slave=${item.slaveAddress}, TypeID=${item.typeId}, ` +
                    `CA=${item.asdu}, IOA=${item.ioa}, Val=${item.val}, Q=${item.quality}` +
                    (item.timestamp ? `, TS=${item.timestamp}` : '')
                );
            });
            return;
        }

        switch (data.event) {
            case 'opened':
                if (data.reason === 'link layer available') {
                    const sa = Number(data.slaveAddress);
                    onlineSlaves.add(sa);
                    console.log(`Master: Slave ${sa} is AVAILABLE`);
                } else {
                    console.log(`Master: Link layer OPENED (${data.reason}) for ${data.slaveAddress}`);
                }
                break;

                case 'initDone':
                    if (!pollStarted) {
                        pollStarted = true;
                        console.log('Master: C++ init DONE, starting JS poll loop.');
                
                        // Запускаем poll
                        setTimeout(pollLoop, CFG.firstPollDelayMs);
                
                        // IC посылаем последовательно, с паузой между slave
                        let delay = 500;
                        for (const sa of CFG.slaveAddresses) {
                            setTimeout(() => {
                                try {
                                    console.log(`[AUTO] Interrogation -> slave ${sa}`);
                                    master.sendInterrogation(sa, 20);   // ★ используем sendInterrogation, не sendCommands
                                } catch (e) {
                                    console.error(`IC failed for slave ${sa}: ${e.message}`);
                                }
                            }, delay);
                            delay += 1500;
                        }
                    }
                    break;

            case 'closed':
                console.log(`Master: Link layer CLOSED for slave ${data.slaveAddress}`);
                onlineSlaves.delete(Number(data.slaveAddress));
                break;

            case 'failed':
            case 'error':
                console.error(`Master: ${data.event.toUpperCase()} for slave ${data.slaveAddress} - ${data.reason}`);
                onlineSlaves.delete(Number(data.slaveAddress));
                break;

            case 'busy':
                console.log(`Master: BUSY for slave ${data.slaveAddress}`);
                break;

            case 'reconnecting':
                console.log(`Master: Reconnecting - ${data.reason}`);
                break;

            case 'interrogationActivation':
                console.log(`Master: Interrogation ACTIVATION on slave ${data.slaveAddress} (COT=6)`);
                break;
            case 'interrogationConfirmed':
                console.log(`Master: Interrogation CONFIRMED on slave ${data.slaveAddress} (COT=7)`);
                break;
            case 'interrogationTerminated':
                console.log(`Master: Interrogation TERMINATED on slave ${data.slaveAddress} (COT=10)`);
                break;
            case 'interrogation':
                console.log(`Master: Interrogation event on slave ${data.slaveAddress} (COT=${data.cot})`);
                break;

            default:
                console.log('Master: Unhandled event:', util.inspect(data, { depth: null }));
        }
    } catch (e) {
        console.error(`CS101 callback error: ${e.message}`);
    }
});

// ============================================================
// Периодический polling (round-robin)
// ============================================================
let pollIdx = 0;
function pollLoop() {
    const st = master.getStatus();
    if (!st.connected) { setTimeout(pollLoop, 2000); return; }

    const live = CFG.slaveAddresses.filter(sa => onlineSlaves.has(sa));
    if (live.length === 0) { setTimeout(pollLoop, 2000); return; }

    const sa = live[pollIdx % live.length];
    pollIdx = (pollIdx + 1) % live.length;

    try {
        master.requestClass1(sa);   // теперь C++ отправит кадр FC=10
    } catch (e) {
        console.error(`requestClass1(${sa}) failed: ${e.message}`);
    }

    setTimeout(pollLoop, CFG.pollIntervalMs);
}

// ============================================================
// Периодический общий опрос
// ============================================================
async function interrogationLoop() {
    if (master.getStatus().connected) {
        for (const sa of CFG.slaveAddresses) {
            if (!onlineSlaves.has(sa)) continue;
            try {
                console.log(`[AUTO] Interrogation -> slave ${sa}`);
                master.sendCommands([{ typeId: 100, ioa: 0, value: 20 }], sa);
                await new Promise(r => setTimeout(r, 3000));
            } catch (e) {
                console.error(`Interrogation error for slave ${sa}: ${e.message}`);
            }
        }
    }
    setTimeout(interrogationLoop, CFG.interrogationMs);
}

// ============================================================
// Запуск
// ============================================================
async function main() {
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    console.log('Starting IEC 60870-5-101 master...');
    console.log(`  port=${CFG.portName}, baud=${CFG.baudRate}`);
    console.log(`  master linkAddress=${CFG.linkAddress}`);
    console.log(`  slaves=${JSON.stringify(CFG.slaveAddresses)}`);
    console.log(`  sizes: link=${CFG.addressLength}, CA=${CFG.sizeOfCA}, ` +
                `COT=${CFG.sizeOfCOT}, IOA=${CFG.sizeOfIOA}`);
    console.log(`  timings: t0=${CFG.t0}, t1=${CFG.t1}, t2=${CFG.t2}`);

    master.connect({
        portName: CFG.portName,
        baudRate: CFG.baudRate,
        clientID: CFG.clientID,
        params: {
            linkAddress:       CFG.linkAddress,
            originatorAddress: 3,
            addressLength:     CFG.addressLength,
            sizeOfCA:          CFG.sizeOfCA,
            sizeOfCOT:         CFG.sizeOfCOT,
            sizeOfIOA:         CFG.sizeOfIOA,
            t0: CFG.t0,
            t1: CFG.t1,
            t2: CFG.t2,
            reconnectDelay: CFG.reconnectDelay,
            queueSize:      CFG.queueSize,
            slaveAddresses: CFG.slaveAddresses,
        }
    });

    await sleep(1000);
    console.log('Initial Status:', util.inspect(master.getStatus()));
    console.log('Master initialized. Waiting for events...');
}

main().catch(err => {
    console.error(`Startup Error: ${err.message}`);
    process.exit(1);
});

// ============================================================
// Завершение
// ============================================================
process.on('SIGINT', () => {
    console.log('\nShutting down CS101 master...');
    try { master.disconnect(); } catch (e) { /* ignore */ }
    process.exit(0);
});