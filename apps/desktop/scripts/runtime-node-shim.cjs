// Test-only adapter for the utility-process message interface. Never packaged.
process.parentPort = {
  on: (_event, listener) => process.on('message', (data) => listener({ data })),
  postMessage: (value) => process.send(value),
};
require(process.argv[2]);
