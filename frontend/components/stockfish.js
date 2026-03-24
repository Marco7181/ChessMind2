importScripts(
  "https://cdn.jsdelivr.net/gh/niklasf/stockfish.wasm/stockfish.js",
);

onmessage = function (event) {
  postMessage(event.data);
  Module.ccall("uci_command", "number", ["string"], [event.data]);
};
