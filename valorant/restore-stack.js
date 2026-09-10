// Emscripten --post-js：为 Worker 提供可重复调用的 CLI 入口。
// 原始 callMain 的 argv 在 WASM 栈上分配；成功、非零退出与异常都必须归还。
// 同时更新 Module 导出与 classic script 的全局，旧版本站调用 self.callMain 也能受益。
(function () {
  var originalCallMain = callMain;
  callMain = function (args) {
    var stack = stackSave();
    try {
      return originalCallMain(args);
    } finally {
      stackRestore(stack);
    }
  };
  Module['callMain'] = callMain;
})();
