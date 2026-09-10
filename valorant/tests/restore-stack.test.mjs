import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../restore-stack.js', import.meta.url), 'utf8');

for (const outcome of ['success', 'nonzero', 'throw']) {
  it(`callMain 的 ${outcome} 分支恢复栈，Module 与全局入口一致`, () => {
    let stack = 65536;
    const failure = new Error('wasm trap');
    const context = vm.createContext({
      Module: {},
      stackSave: () => stack,
      stackRestore: saved => { stack = saved; },
      callMain: args => {
        assert.deepEqual(args, ['-I']);
        stack -= 128;
        if (outcome === 'throw') throw failure;
        return outcome === 'success' ? 0 : 1;
      },
    });
    vm.runInContext(source, context);
    assert.equal(context.Module.callMain, context.callMain);
    for (let i = 0; i < 1000; i++) {
      if (outcome === 'throw') assert.throws(() => context.callMain(['-I']), error => error === failure);
      else assert.equal(context.callMain(['-I']), outcome === 'success' ? 0 : 1);
      assert.equal(stack, 65536);
    }
  });
}
