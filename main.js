'use strict';

const utils = require('@iobroker/adapter-core');
const dgram = require('dgram');
const uuid = require('./lib/uuid');
const acc = require('./lib/aes');

const adapterName = require('./package.json').name.split('.').pop();
let client = dgram.createSocket('udp4');
let pendingUpdates = {}; // *** NEU *** Variable zum Verfolgen von anstehenden Abfragen

let adapter;
let key = "";
let openPercent = "";

function startAdapter(options) {
    options = options || {};
    Object.assign(options, { name: adapterName });
    adapter = new utils.Adapter(options);

    adapter.on('ready', function () {
        main();
    });

    adapter.on('objectChange', function (id, obj) {
        if (obj) {
            // The object was changed
            adapter.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
        } else {
            // The object was deleted
            adapter.log.info(`object ${id} deleted`);
        }
    });

    // *** GEÄNDERT *** Komplette stateChange Funktion ersetzt
    adapter.on('stateChange', function (id, state) {
        if (!id || !state || state.ack) {
            return;
        }
        if (key.length !== 16) {
            adapter.log.info("please enter the right key");
            return;
        }
        const pos = id.lastIndexOf('.');
        const channelId = id.substring(0, pos);
        const IDkeys = id.split('.');
        const IDState = IDkeys[IDkeys.length - 1];

        let TempOperation = null;
        let TempTargetPosition = null;
        let TempTargetAngle = null;

        adapter.getObject(channelId, (err, obj) => {
            if (err || !obj || !obj.native) {
                adapter.log.error(`Could not get object or native data for ${channelId}`);
                return;
            }

            const deviceMac = obj.native.mac;

            if (IDState === "up") {
                TempOperation = 1;
            } else if (IDState === "down") {
                TempOperation = 0;
            } else if (IDState === "stop") {
                TempOperation = 2;
            } else if (IDState === "targetPosition") {
                TempTargetPosition = parseInt(state.val);
            } else if (IDState === "fav") {
                TempOperation = 12;
            } else if (IDState === "targetAngle") {
                TempTargetAngle = parseInt(state.val);
            }

            // Steuerung ausführen
            if (TempOperation !== null) {
                controlDevice(TempOperation, null, deviceMac, obj.native.deviceType, obj.native.token, key, null);
            } else if (TempTargetPosition !== null) {
                let targetPosValue = TempTargetPosition;
                if (openPercent === "100") {
                    targetPosValue = 100 - TempTargetPosition;
                }
                controlDevice(null, targetPosValue, deviceMac, obj.native.deviceType, obj.native.token, key, null);
            } else if (TempTargetAngle !== null) {
                controlDevice(null, null, deviceMac, obj.native.deviceType, obj.native.token, key, TempTargetAngle);
            }

            // *** NEU *** Fallback-Timer starten
            // Nur bei Hoch- oder Runterfahren einen Timer starten
            if (TempOperation === 1 || TempOperation === 0) {
                adapter.log.info(`Starting 45s fallback timer for device ${deviceMac}`);
                pendingUpdates[deviceMac] = true; // Status-Abfrage als "anstehend" markieren

                setTimeout(() => {
                    // Prüfen, ob nach 45 Sekunden immer noch ein Update für dieses Gerät ansteht
                    if (pendingUpdates[deviceMac]) {
                        adapter.log.warn(`No automatic update for ${deviceMac} received. Requesting status now.`);
                        // Flag löschen, damit wir nicht mehrfach abfragen
                        delete pendingUpdates[deviceMac];
                        // Statusabfrage senden (Operation 5)
                        controlDevice(5, null, deviceMac, obj.native.deviceType, obj.native.token, key, null);
                    }
                }, 45000); // 45 Sekunden
            }
        });
    });

    return adapter;
}

function setStates(id, val) {
    adapter.setState(id, {
        val: val,
        ack: true
    });
    return '';
}

async function main() {
    client.bind(32101, function () {
        client.addMembership('238.0.0.18');
    })

    key = adapter.config.user;
    openPercent = adapter.config.openPercent;
    adapter.subscribeStates('*');

    getDeviceList()

    client.on('message', (msg, rinfo) => {
        adapter.log.info(`receive server message from ${rinfo.address}: ${rinfo.port}: ${msg}`);
        let obj = JSON.parse(msg.toString());
        if (obj.msgType === "GetDeviceListAck") {
            adapter.setObjectNotExists(obj.mac, {
                type: 'device',
                common: {
                    name: obj.mac,
                    role: 'room'
                },
                native: {
                    token: obj.token,
                    deviceType: obj.deviceType,
                    mac: obj.mac
                }
            });
            for (var motor in obj.data) {
                if (obj.mac !== obj.data[motor].mac) {
                    adapter.setObjectNotExists(obj.mac + '.' + obj.data[motor].mac, {
                        type: 'channel',
                        common: {
                            name: obj.data[motor].mac,
                            role: 'blind'
                        },
                        native: {
                            token: obj.token,
                            mac: obj.data[motor].mac,
                            deviceType: obj.data[motor].deviceType,
                            hubMac: obj.mac
                        }
                    });

                    adapter.setObjectNotExists(obj.mac + '.' + obj.data[motor].mac + '.down', {
                        type: 'state',
                        common: { name: 'down', type: 'boolean', role: 'button', write: true, read: false }
                    });

                    adapter.setObjectNotExists(obj.mac + '.' + obj.data[motor].mac + '.stop', {
                        type: 'state',
                        common: { name: 'stop', type: 'boolean', role: 'button', write: true, read: false }
                    });

                    adapter.setObjectNotExists(obj.mac + '.' + obj.data[motor].mac + '.up', {
                        type: 'state',
                        common: { name: 'up', type: 'boolean', role: 'button', write: true, read: false }
                    });

                    adapter.setObjectNotExists(obj.mac + '.' + obj.data[motor].mac + '.fav', {
                        type: 'state',
                        common: { name: 'fav', type: 'boolean', role: 'button', write: true, read: false }
                    });

                    adapter.setObjectNotExists(obj.mac + '.' + obj.data[motor].mac + '.targetPosition', {
                        type: 'state',
                        common: { name: 'targetPosition', type: 'number', unit: '%', role: 'level.blind', write: true, read: true, min: 0, max: 100 }
                    });

                    adapter.setObjectNotExists(obj.mac + '.' + obj.data[motor].mac + '.targetAngle', {
                        type: 'state',
                        common: { name: 'targetAngle', type: 'number', unit: '°', role: 'level.tilt', write: true, read: true, min: 0, max: 180 }
                    });

                    adapter.setObjectNotExists(obj.mac + '.' + obj.data[motor].mac + '.rssi', {
                        type: 'state',
                        common: { name: 'rssi', type: 'number', unit: 'dBm', role: 'value.rssi', write: false, read: true }
                    });

                    adapter.setObjectNotExists(obj.mac + '.' + obj.data[motor].mac + '.batteryLevel', {
                        type: 'state',
                        common: { name: 'batteryLevel', type: 'number', unit: 'V', role: 'value.voltage', write: false, read: true }
                    });

                    adapter.setObjectNotExists(obj.mac + '.' + obj.data[motor].mac + '.currentPosition', {
                        type: 'state',
                        common: { name: 'currentPosition', type: 'number', unit: '%', role: 'level.blind', write: false, read: true, min: 0, max: 100 }
                    });

                    adapter.setObjectNotExists(obj.mac + '.' + obj.data[motor].mac + '.currentAngle', {
                        type: 'state',
                        common: { name: 'currentAngle', type: 'number', unit: '°', role: 'level.tilt', write: false, read: true, min: 0, max: 180 }
                    });

                    setStates(obj.mac + '.' + obj.data[motor].mac + '.currentPosition', "unknown");

                    setStates(obj.mac + '.' + obj.data[motor].mac + '.currentAngle', "unknown");

                    if (key.length === 16) {
                        controlDevice(5, null, obj.data[motor].mac, obj.data[motor].deviceType, obj.token, key, null);
                    }
                }
            }
        }
        if (obj.msgType === "WriteDeviceAck") {
            adapter.log.info("WriteDeviceAck");
        }
        if (obj.msgType === "Heartbeat") {
            adapter.log.info("Heartbeat");
        }

        // *** GEÄNDERT *** Report-Block mit Fallback-Logik
        if (obj.msgType === "Report") {
            const deviceMac = obj.mac;
            const hub_mac = deviceMac.substring(0, deviceMac.length - 4);

            // *** NEU *** Fallback-Timer abbrechen
            // Prüfen, ob für dieses Gerät eine Abfrage anstand
            if (pendingUpdates[deviceMac]) {
                adapter.log.info(`Automatic report for ${deviceMac} received. Cancelling fallback query.`);
                delete pendingUpdates[deviceMac]; // Anstehende Abfrage entfernen
            }

            if (obj.data.hasOwnProperty("currentPosition")) {
                let currentPos = obj.data.currentPosition;
                if (openPercent === "100") {
                    currentPos = 100 - currentPos;
                }
                setStates(hub_mac + '.' + deviceMac + '.currentPosition', currentPos.toString());
            }

            if (obj.data.hasOwnProperty("RSSI")) {
                setStates(hub_mac + '.' + deviceMac + '.rssi', obj.data.RSSI.toString());
            }
            if (obj.data.hasOwnProperty("currentAngle")) {
                setStates(hub_mac + '.' + deviceMac + '.currentAngle', obj.data.currentAngle.toString());
            }
            if (obj.data.voltageMode === 1) {
                if (obj.data.hasOwnProperty("batteryLevel")) {
                    setStates(hub_mac + '.' + deviceMac + '.batteryLevel', (obj.data.batteryLevel / 100).toString());
                }
            } else {
                setStates(hub_mac + '.' + deviceMac + '.batteryLevel', "120 or 220");
            }
        }
    });
}

function getDeviceList() {
    let sendData_obj = {
        msgType: "GetDeviceList",
        msgID: uuid.generateUUID(),
    }
    let sendData = JSON.stringify(sendData_obj);
    //adapter.log.info("send：" + sendData);
    client.send(sendData, 32100, '238.0.0.18', function (error) {
        if (error) {
            console.log(error)
        }
    })
}

function controlDevice(operation, targetPosition, mac, deviceType, token, key, targetAngle) { //控制设备
    //adapter.log.info("enter device control")
    let sendData_obj;
    if (operation !== null) {
        sendData_obj = {
            msgType: "WriteDevice",
            mac: mac,
            deviceType: deviceType,
            AccessToken: acc.generateAcc(token, key),
            msgID: uuid.generateUUID(),
            data: {
                operation: operation
            }
        }
    } else if (targetPosition != null) {
        sendData_obj = {
            msgType: "WriteDevice",
            mac: mac,
            deviceType: deviceType,
            AccessToken: acc.generateAcc(token, key),
            msgID: uuid.generateUUID(),
            data: {
                targetPosition: targetPosition
            }
        }
    } else if (targetAngle != null) {
        sendData_obj = {
            msgType: "WriteDevice",
            mac: mac,
            deviceType: deviceType,
            AccessToken: acc.generateAcc(token, key),
            msgID: uuid.generateUUID(),
            data: {
                targetAngle: targetAngle
            }
        }
    }
    if (sendData_obj) {
        sendData(JSON.stringify(sendData_obj));
    }
}

function sendData(data) {
    // console.log("send：" + data);
    client.send(data, 32100, '238.0.0.18', function (error) {
        if (error) {
            adapter.log.info("send failed:" + error);
        }
    })
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export startAdapter in compact mode
    module.exports = startAdapter;
} else {
    // otherwise start the instance directly
    startAdapter();
}