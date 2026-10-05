/**
 * scanner.js — сканирование slave'ов 101 для отображения дерева каналов.
 */

const util = require('util');

class Scanner {
    constructor(plugin) {
        this.plugin = plugin;
        this.status = 0;          // 0 - не активно, 1 - первое дерево, 2 - дерево достраивается
        this.clientID = '';
        this.slaveAddress = 0;
        this.session = null;
        this.scanArray = [];
        this.idSet = new Set();
        this.clients = new Set(); // uuid подписчиков сканирования
    }

    start(session, slaveAddress, uuid) {
        this.status = 1;
        this.session = session;
        this.slaveAddress = Number(slaveAddress);
        this.clientID = 'slave' + this.slaveAddress;

        this.plugin.log(`Scanner start: slave=${this.slaveAddress}`, 2);

        this.scanArray = [{
            id: this.clientID,
            browseName: this.clientID,
            title: 'Slave ' + this.slaveAddress,
            nodeClass: 1,
            parentId: ''
        }];
        this.idSet = new Set();

        const data = [this.makeTree()];
        this.clients.forEach(u => this.sendTree(u, data));
        this.status = 2;

        try {
            const ok = this.session.sendCommands(
                [{ typeId: 100, ioa: 0, value: 20 }],
                this.slaveAddress
            );
            this.plugin.log(
                ok ? `Scanner: Interrogation OK (slave ${this.slaveAddress})`
                   : `Scanner: Interrogation FAILED (slave ${this.slaveAddress})`,
                2
            );
        } catch (e) {
            this.plugin.log('Scanner error: ' + util.inspect(e), 2);
            this.stop();
        }
    }

    request(session, slaveAddress, uuid) {
        this.clients.add(uuid);

        if (this.status === 2 && this.slaveAddress === Number(slaveAddress)) {
            this.sendTree(uuid);
            return;
        }
        if (this.status !== 0 && this.slaveAddress !== Number(slaveAddress)) {
            // Смена slave без очистки подписчиков
            this.stop();
            // Восстанавливаем подписчиков после stop
            this.clients.add(uuid);
        }
        if (this.status === 0) {
            this.start(session, slaveAddress, uuid);
        }
    }

    sendData(data) {
        if (this.slaveAddress && Number(data.slaveAddress) !== this.slaveAddress) return;

        const id = 'ioa_' + data.ioa;
        if (this.idSet.has(id)) return;
        this.idSet.add(id);

        const title = this.getType(data.typeId) + ' adr:' + data.ioa + ' val:' + data.val;

        const leaf = {
            parentId: this.clientID,
            id,
            title,
            channel: {
                topic: title,
                chan: 'Control Object adr:' + data.ioa,
                ioObjMtype: data.typeId,
                objAdr: data.ioa,
                cmdAdr: data.ioa,
                r: 1
            }
        };
        this.scanArray.push(leaf);
        this.sendTreePart(leaf, this.clientID);
    }

    sendTree(uuid, data) {
        if (!data) data = [this.makeTree()];
        this.plugin.send({ type: 'scan', op: 'list', data, uuid });
    }

    sendTreePart(data, parentid) {
        this.plugin.send({ type: 'scan', op: 'add', data, parentid, scanid: 'root' });
    }

    makeTree() {
        const ids = this.scanArray.reduce((acc, el, i) => { acc[el.id] = i; return acc; }, {});
        let root;
        this.scanArray.forEach(el => {
            if (!el.parentId) { root = el; return; }
            const p = this.scanArray[ids[el.parentId]];
            if (p) p.children = [...(p.children || []), el];
        });
        return root;
    }

    stop() {
        // ВАЖНО: clients НЕ очищаем здесь — иначе потеряем подписчиков
        // Очистку делает вызывающий код (app.js при scanObj.stop)
        this.idSet.clear();
        this.scanArray = [];
        this.clientID = '';
        this.slaveAddress = 0;
        this.session = null;
        this.status = 0;
    }

    getType(v) {
        const t = {
            1: 'M_SP_NA (1)', 3: 'M_DP_NA (3)', 5: 'M_ST_NA (5)', 7: 'M_BO_NA (7)',
            9: 'M_ME_NA (9)', 11: 'M_ME_NB (11)', 13: 'M_ME_NC (13)', 15: 'M_IT_NA (15)',
            30: 'M_SP_TB (30)', 31: 'M_DP_TB (31)', 32: 'M_ST_TB (32)', 33: 'M_BO_TB (33)',
            34: 'M_ME_TD (34)', 35: 'M_ME_TE (35)', 36: 'M_ME_TF (36)', 37: 'M_IT_TB (37)',
            45: 'C_SC_NA (45)', 46: 'C_DC_NA (46)', 47: 'C_RC_NA (47)', 48: 'C_SE_NA (48)',
            49: 'C_SE_NB (49)', 50: 'C_SE_NC (50)', 51: 'C_BO_NA (51)',
            58: 'C_SC_TA (58)', 59: 'C_DC_TA (59)', 60: 'C_RC_TA (60)',
            61: 'C_SE_TA (61)', 62: 'C_SE_TB (62)', 63: 'C_SE_TC (63)', 64: 'C_BO_TA (64)',
            70: 'M_EI_NA (70)',
            100: 'C_IC_NA (100)', 101: 'C_CI_NA (101)', 102: 'C_RD_NA (102)', 103: 'C_CS_NA (103)'
        };
        return t[v] || String(v);
    }
}

module.exports = Scanner;