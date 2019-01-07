/*
 * CDDL HEADER START
 *
 * The contents of this file are subject to the terms of the
 * Common Development and Distribution License, Version 1.0 only
 * (the "License").  You may not use this file except in compliance
 * with the License.
 *
 * You can obtain a copy of the license at http://smartos.org/CDDL
 *
 * See the License for the specific language governing permissions
 * and limitations under the License.
 *
 * When distributing Covered Code, include this CDDL HEADER in each
 * file.
 *
 * If applicable, add the following below this CDDL HEADER, with the
 * fields enclosed by brackets "[]" replaced with your own identifying
 * information: Portions Copyright [yyyy] [name of copyright owner]
 *
 * CDDL HEADER END
 *
 * Copyright (c) 2018, Joyent, Inc.
 *
 */

var assert = require('/usr/node/node_modules/assert-plus');
var cp = require('child_process');
var execFile = cp.execFile;
var jsprim = require('/usr/vm/node_modules/jsprim');
var net = require('net');
var sprintf = require('/usr/node/node_modules/sprintf').sprintf;
var vasync = require('/usr/vm/node_modules/vasync');
var VM = require('/usr/vm/node_modules/VM');
var vmtest = require('../common/vmtest.js');

// this puts test stuff in global, so we need to tell jsl about that:
/* jsl:import ../node_modules/nodeunit-plus/index.js */
require('nodeunit-plus');

VM.loglevel = 'DEBUG';

var ADMIN_IP = null;

function getAdminIp(cb)
{
    assert.func(cb, 'cb');

    execFile('/usr/bin/sysinfo', [], function (error, stdout, stderr) {
        var nic, nics, si;

        if (error) {
            throw new Error(stderr.toString());
        }

        // nic tags are in sysinfo but not readily available, we need
        // admin_ip to know where to listen for stuff like VNC.
        si = JSON.parse(stdout.toString());
        nics = si['Network Interfaces'];
        for (nic in nics) {
            if (nics.hasOwnProperty(nic)) {
                if (nics[nic]['NIC Names'].indexOf('admin') !== -1) {
                    cb(nics[nic].ip4addr);
                    return;
                }
            }
        }
        throw new Error('Could not find admin network');
    });
}

/*
 * nodeuninit-plus executes the callback specified by before() before each test
 * is run and executes the callback specified by after() after each test is run.
 * These callbacks ensure that vmobj is initialized to undefined prior to each
 * test and that any VM that was created by the test is deleted after the test
 * completes.
 *
 * Tests that create a VM should be setting vmobj so that the after() hook can
 * clean up the VM when the test finishes or gives up.  If a test uses vmobj
 * then deletes the VM on its own, it should set vmobj to undefined.
 */
var vmobj;

before(function _before(cb) {
    assert.func(cb, 'cb');
    vmobj = undefined;
    if (ADMIN_IP === null) {
        console.log('getting ip');
        assert.func(cb, 'cb');
        getAdminIp(function _gotIp(ip) {
            ADMIN_IP = ip;
            console.log('got ip ' + ADMIN_IP);
            cb()
        });
    } else {
        cb();
    }
});

after(function _after(cb) {
    assert.func(cb, 'cb');
    if (!vmobj) {
        cb();
        return;
    }
    VM.delete(vmobj.uuid, {}, function _delete_cb(err) {
        if (err) {
            console.log(sprintf('Could not delete vm %s: %s', vmobj.uuid,
                err.message));
        }
        vmobj = undefined;
        cb();
    });
});

function createVM(options, payload, next)
{
    assert.obj(options);

    VM.create(payload, function _create_cb(err, obj) {
        if (err) {
            t.ok(false, 'error creating VM: ' + err);
        } else {
            t.ok(true, 'VM created with uuid ' + obj.uuid);
        }
        vmobj = obj;
        next(err, t);
    });
}

function loadVM(t, next)
{
    VM.load(vmobj.uuid, function _load_cb(err, obj) {
        if (err) {
            t.ok(false, 'error loading VM: ' + err);
        } else {
            t.ok(true, 'VM loaded uuid ' + obj.uuid);
            vmobj = obj;
        }
        next(err, t);
    });
}

function checkRunning(t, next)
{
    t.equal(vmobj.state, 'running', 'VM is running');
    if (vmobj.state !== 'running') {
        next(new Error('VM is in state "%s", not "running"', vmobj.state));
        return;
    }
    next(null, t);
}

function checkVncRandomPort(t, next)
{
    if (vmobj.hasOwnProperty('vnc_port')) {
        var err = new Error('VM has vnc_port statically set');
        t.ok(false, err.message);
        next(err);
        return;
    }

    VM.info(vmobj.uuid, 'vnc', {}, function _getVncPort(err, info) {
        if (err) {
            t.ok(false, 'VM.info failed: ' + err.message);
            next(err);
            return;
        }
        if (info.hasOwnProperty('vnc') && info.vnc.hasOwnProperty('port')) {
            t.ok(true, 'found dynamic vnc port: ' + info.vnc.port);
        } else {
            t.ok(false,
                'no vnc.port returned by VM.info(): ' + JSON.stringify(info));
        }

        t.ok(info.hasOwnProperty('vnc'), 'vnc object found in results');
        t.ok(info.vnc.hasOwnProperty('port'), 'vnc object found in results');
    });

    next(null, t);
}

function connectVnc(t, next)
{
    if (!vmobj.hasOwnProperty('vnc_port')) {
        t.ok(false, 'VM does not have vnc_port set');
        next(new Error('VM does not have vnc_port set'));
        return;
    }

    var client = net.Socket();
    var found = false;
    client.timeout(5000, function _timeout() {
        t.ok(false, 'timeout');
        next(null, t);
    });
    client.connect(vmobj.vnc_port, ADMIN_IP, function _connect() {
        t.ok(true, sprintf('connect to %s port %d', ADMIN_IP, vmobj.vnc_port));
    });
    client.on('data', function _data(data) {
        t.strictEqual(data.slice(0, 3), 'RFB', 'RFB greeting: "' + data + '"');
        found = (data.slice(0, 3) === 'RFB');
        client.destroy();
    });
    client.on('closed', function _closed() {
        if (!found) {
            t.ok(false, 'RFB greeting now seen before close');
        }
        next(null, t);
    });
}

/*
 * A wrapper around test() that runs the same test for bhyve and kvm. callback
 * is called as callback(t, brand).
 */
function testHVM(name, callback)
{
    ['bhyve', 'kvm'].forEach(function testBrand(brand) {
        test(brand + ': ' +  name, function testHVMbrand(t) {
            callback(t, brand);
        });
    });
}

/*
 * Common payload elements
 */
var image_uuid = vmtest.CURRENT_BHYVE_CENTOS_UUID;

var base_payload = {
    alias: 'test-vnc-' + process.pid,
    brand: 'bhyve',
    do_not_inventory: true,
    autoboot: false,
    ram: 256,
    vcpus: 1,
    disks: [
        {
            image_uuid: image_uuid,
            boot: true,
            model: 'virtio'
        }
    ]
};

/*
 * Tests, finally!
 *
 * Remember that the functions passed by before() and after() are called before
 * and after each test.
 */

testHVM('provision with autoboot has working vnc at random port',
    function vncTest1(t, brand) {
        var payload = jsprim.deepCopy(base_payload);
        payload.autoboot = true;
        payload.brand = brand;

        assert(!payload.hasOwnProperty('vnc_port'),
            'payload does not have vnc_port');

        vasync.waterfall([
            function _create(next) {
                createVM(t, payload, next);
            },
            loadVM,
            checkRunning,
            checkVncRandomPort,
            connectVnc
            ], function (err) {
                t.end();
            }
        );
    });
/*
testHVM('provision then boot has working vnc at random port',
    function vncTest2(t, brand) {
        t.ok(false, 'not implmented');
        t.end();
    });
testHVM('provision with vnc_port set has vnc at specified port',
    function vncTest3(t, brand) {
        t.ok(false, 'not implmented');
        t.end();
    });
testHVM('vnc stops listening with vmadm stop',
    function vncTest4(t, brand) {
        t.ok(false, 'not implmented');
        t.end();
    });
testHVM('vnc stops listening with zoneadm shutdown',
    function vncTest5(t, brand) {
        t.ok(false, 'not implmented');
        t.end();
    });
testHVM('vnc stops listening with guest-initiated poweroff',
    function vncTest6(t, brand) {
        t.ok(false, 'not implmented');
        t.end();
    });
testHVM('vnc works across guest-initiated reboot',
    function vncTest7(t, brand) {
        t.ok(false, 'not implmented');
        t.end();
    });
testHVM('vnc_port=0 means random',
    function vncTest8(t, brand) {
        t.ok(false, 'not implmented');
        t.end();
    });
testHVM('vnc_port=-1 means disabled',
    function vncTest9(t, brand) {
        t.ok(false, 'not implmented');
        t.end();
    });
testHVM('vmadm update vnc_port affects live instance',
    function vncTest10(t, brand) {
        t.ok(false, 'not implmented');
        t.end();
    });
*/
