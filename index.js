/**
 * iec60870-101master index.js
 */

console.log('=== IDX: file start, pid=' + process.pid + ' ===');
console.log('=== IDX: argv = ' + JSON.stringify(process.argv) + ' ===');
console.log('=== IDX: cwd = ' + process.cwd() + ' ===');
console.log('=== IDX: node = ' + process.version + ' ===');
console.log('=== IDX: execPath = ' + process.execPath + ' ===');

const util = require('util');

console.log('=== IDX: about to require ./app ===');
const app = require('./app');
console.log('=== IDX: app required OK, type = ' + typeof app + ' ===');

let plugin;

process.on('unhandledRejection', (reason, promise) => {
  const msg = '!!! UNHANDLED REJECTION: ' + util.inspect(reason, { depth: 5 });
  console.error(msg);
  if (plugin && plugin.log) plugin.log(msg, 0);
  if (reason && reason.stack) {
    console.error('!!! REJECTION STACK:', reason.stack);
    if (plugin && plugin.log) plugin.log('!!! REJECTION STACK: ' + reason.stack, 0);
  }
});

process.on('uncaughtException', (err) => {
  const msg = '!!! UNCAUGHT EXCEPTION: ' + util.inspect(err, { depth: 5 });
  console.error(msg);
  if (plugin && plugin.log) plugin.log(msg, 0);
  if (err && err.stack) {
    console.error('!!! EXCEPTION STACK:', err.stack);
    if (plugin && plugin.log) plugin.log('!!! EXCEPTION STACK: ' + err.stack, 0);
  }
  process.exit(1);
});

(async () => {
  try {
    const opt = getOptFromArgs();
    const pluginapi = opt && opt.pluginapi ? opt.pluginapi : 'ih-plugin-api';

    plugin = require(pluginapi + '/index.js')();
    plugin.log('Plugin IEC60870-5-101 master has started.', 0);

    plugin.params.data = await plugin.params.get();
    plugin.logger.setParams(plugin.params.data);
    plugin.log('Received params data: ' + util.inspect(plugin.params.data));

    // ВАЖНО: await, чтобы отловить ошибку из app()
    await app(plugin);

    plugin.log('Plugin IEC60870-5-101 master initialized OK.', 0);
  } catch (err) {
    const msg = '!!! INDEX.JS ERROR: ' + util.inspect(err, { depth: 5 });
    console.error(msg);
    if (plugin && plugin.log) plugin.log(msg, 0);
    if (err && err.stack) {
      console.error('!!! INDEX.JS STACK:', err.stack);
      if (plugin && plugin.log) plugin.log('!!! INDEX.JS STACK: ' + err.stack, 0);
    }
    if (plugin && plugin.exit) {
      plugin.exit(8, `Error: ${util.inspect(err)}`);
    } else {
      process.exit(8);
    }
  }
})();

function getOptFromArgs() {
  let opt;
  try {
    opt = JSON.parse(process.argv[2]);
  } catch (e) {
    opt = {};
  }
  return opt;
}
