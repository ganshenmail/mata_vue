(function (global) {
  'use strict';

  /* ==================== 1. Dep（依赖收集器） ==================== */
  var uid = 0;
  function Dep() {
    this.id = uid++;
    this.subs = [];
  }
  Dep.target = null;
  Dep.prototype.addSub = function (s) { this.subs.push(s); };
  Dep.prototype.removeSub = function (s) {
    var i = this.subs.indexOf(s);
    if (i > -1) this.subs.splice(i, 1);
  };
  Dep.prototype.depend = function () { if (Dep.target) Dep.target.addDep(this); };
  Dep.prototype.notify = function () {
    var subs = this.subs.slice();
    for (var i = 0; i < subs.length; i++) subs[i].update();
  };

  // Dep.target 使用堆栈，支持嵌套求值（如 computed 求值时能还原外层渲染 watcher）
  var targetStack = [];
  function pushTarget(target) {
    if (Dep.target) targetStack.push(Dep.target);
    Dep.target = target;
  }
  function popTarget() {
    Dep.target = targetStack.length ? targetStack.pop() : null;
  }

  function noop() {}

  /* ==================== 2. Watcher（观察者） ==================== */
  var wuid = 0;
  // 列表渲染分组栈：v-for 重建子树期间新建的 watcher 会登记进当前分组，便于下次重建前统一回收。
  // 用"栈"而非单个变量，是为了支持嵌套 v-for：内层分组退出后能恢复外层分组，避免外层 watcher 回收遗漏。
  var watcherGroupStack = [];
  function currentGroup() { return watcherGroupStack.length ? watcherGroupStack[watcherGroupStack.length - 1] : null; }
  function Watcher(vm, getter, cb, options) {
    this.vm = vm;
    this.id = ++wuid;
    this.cb = cb;
    this.deps = [];
    this.newDeps = [];
    this.depIds = {};
    this.newDepIds = {};
    options = options || {};
    this.lazy = !!options.lazy;
    this.lazyInit = !!options.lazyInit;
    this.sync = !!options.sync;
    this.deep = !!options.deep;
    this.dirty = this.lazy || this.lazyInit;
    this.active = true;
    this.getter = typeof getter === 'function' ? getter : parsePath(getter);
    this.value = (this.lazy || this.lazyInit) ? undefined : this.get();
    // 记录到实例，供 $destroy 统一回收
    if (vm && vm._watchers) vm._watchers.push(this);
    // 若处于 v-for 重建分组中，则并入当前分组，供下次重建前统一 teardown
    var g = currentGroup();
    if (g) g.push(this);
  }
  Watcher.prototype.get = function () {
    pushTarget(this);
    var value = this.getter.call(this.vm, this.vm);
    // 深度监听：在收集期间遍历值树，让嵌套 key 也登记到当前 watcher
    if (this.deep) deepTraverse(value);
    popTarget();
    this.cleanupDeps();
    return value;
  };
  Watcher.prototype.addDep = function (dep) {
    if (!this.newDepIds[dep.id]) {
      this.newDepIds[dep.id] = true;
      this.newDeps.push(dep);
      if (!this.depIds[dep.id]) dep.addSub(this);
    }
  };
  Watcher.prototype.cleanupDeps = function () {
    for (var i = 0; i < this.deps.length; i++) {
      var dep = this.deps[i];
      if (!this.newDepIds[dep.id]) dep.removeSub(this);
    }
    this.depIds = this.newDepIds;
    this.newDepIds = {};
    this.deps = this.newDeps;
    this.newDeps = [];
  };
  Watcher.prototype.update = function () {
    if (this.lazy) this.dirty = true;
    else if (this.sync) this.run();
    else queueWatcher(this);
  };
  Watcher.prototype.run = function () {
    if (!this.active) return;
    var value = this.get();
    if (value !== this.value || (value && typeof value === 'object')) {
      var old = this.value;
      this.value = value;
      this.cb.call(this.vm, value, old);
    }
  };
  Watcher.prototype.evaluate = function () { this.value = this.get(); this.dirty = false; };
  Watcher.prototype.depend = function () {
    for (var i = 0; i < this.deps.length; i++) this.deps[i].depend();
  };
  Watcher.prototype.teardown = function () {
    if (!this.active) return;
    this.active = false;
    var i = this.deps.length;
    while (i--) this.deps[i].removeSub(this);
  };

  /* ==================== A1 批量调度：队列 + 微任务 flush ==================== */
  var uidCounter = 0;
  var scheduledHas = {};
  var queue = [];
  var flushing = false;
  var queueIndex = 0;
  var waiting = false;

  function queueWatcher(watcher) {
    var id = watcher.id;
    if (scheduledHas[id] != null) return; // A6 同 tick 去重
    scheduledHas[id] = true;
    if (!flushing) {
      queue.push(watcher);
    } else {
      var i = queue.length - 1;
      while (i > queueIndex && queue[i].id > id) i--;
      queue.splice(i + 1, 0, watcher);
    }
    if (!waiting) {
      waiting = true;
      Vue.prototype.nextTick(flushSchedulerQueue);
    }
  }

  function flushSchedulerQueue() {
    flushing = true;
    // 同一批次内、同一实例只触发一次 beforeUpdate / updated（按 uid 去重）
    var perf = Vue && Vue.config && Vue.config.performance;
    if (perf && console.time) console.time('MataVue-update');
    var updatedVms = {};
    for (queueIndex = 0; queueIndex < queue.length; queueIndex++) {
      var watcher = queue[queueIndex];
      scheduledHas[watcher.id] = null;
      var vm = watcher.vm;
      if (vm && vm._uid != null && !updatedVms[vm._uid]) {
        updatedVms[vm._uid] = vm;
        callHook(vm, 'beforeUpdate');
      }
      try { watcher.run(); }
      catch (e) { handleError(watcher.vm, e, '渲染/监听 watcher 执行'); }
    }
    for (var u in updatedVms) callHook(updatedVms[u], 'updated');
    if (perf && console.timeEnd) console.timeEnd('MataVue-update');
    resetSchedulerState();
  }

  function resetSchedulerState() {
    flushing = false;
    queueIndex = 0;
    queue.length = 0;
    scheduledHas = {};
    waiting = false;
  }

  function parsePath(path) {
    var seg = String(path).split('.');
    return function (obj) {
      var r = obj;
      for (var i = 0; i < seg.length; i++) { if (r == null) return undefined; r = r[seg[i]]; }
      return r;
    };
  }

  /* ==================== 3. 响应式系统（Proxy 版） ==================== */
  // 用 Proxy 拦截对象的所有操作：无需预先声明 key，新增/删除属性、数组索引赋值/方法
  // （push/splice/下标写入）都能自动派发更新，彻底解决 defineProperty 方案的遗留问题。
  var hasNativeProxy = typeof Proxy !== 'undefined' && typeof Reflect !== 'undefined';
  var ITERATE_KEY = typeof Symbol !== 'undefined' ? Symbol('iterate') : 'iterate';
  // 依赖图：rawTarget -> (key -> Dep)。用 WeakMap 外挂，避免往数据对象里注入字段污染原数据。
  var targetMap = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  // 代理缓存，防止同一对象被重复包装 / 代理套代理。
  var rawToProxy = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  var proxyToRaw = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

  function isObject(v) { return v !== null && typeof v === 'object'; }

  // 依赖收集：当前活跃 watcher 订阅 key 对应的 Dep
  function track(target, key) {
    if (!Dep.target || !targetMap) return;
    var depsMap = targetMap.get(target);
    if (!depsMap) { depsMap = new Map(); targetMap.set(target, depsMap); }
    var dep = depsMap.get(key);
    if (!dep) { dep = new Dep(); depsMap.set(key, dep); }
    dep.depend();
  }

  // 派发更新：通知订阅了该 key 的所有 watcher
  function trigger(target, key) {
    if (!targetMap) return;
    var depsMap = targetMap.get(target);
    if (!depsMap) return;
    var dep = depsMap.get(key);
    if (dep) dep.notify();
  }

  // 深度监听遍历：借助响应式代理的 get 陷阱，递归读取每个嵌套 key，
  // 从而把深层依赖登记到当前活跃 watcher。seen 用于打断循环引用。
  function deepTraverse(val) {
    if (isObject(val)) deepTraverseWalk(val, new Set());
  }
  function deepTraverseWalk(val, seen) {
    if (!isObject(val) || seen.has(val)) return;
    seen.add(val);
    var i, keys;
    if (Array.isArray(val)) {
      for (i = 0; i < val.length; i++) deepTraverseWalk(val[i], seen);
    } else {
      keys = Object.keys(val);
      for (i = 0; i < keys.length; i++) deepTraverseWalk(val[keys[i]], seen);
    }
  }

  var reactiveHandlers = {
    get: function (target, key, receiver) {
      var res = Reflect.get(target, key, receiver);
      if (typeof key !== 'symbol') track(target, key);
      // 懒代理：读到嵌套子对象时才包装，覆盖运行时新增的深层数据，同时减少初始化开销
      if (isObject(res)) return toReactive(res);
      return res;
    },
    set: function (target, key, value, receiver) {
      var had = Object.prototype.hasOwnProperty.call(target, key);
      // 写入的新对象同样转成响应式，保证后续对该对象的深层修改仍可被追踪
      if (isObject(value)) value = toReactive(value);
      var res = Reflect.set(target, key, value, receiver);
      if (res) {
        if (!had) trigger(target, ITERATE_KEY); // 新增键：让 v-for / 遍历也能感知
        trigger(target, key);
      }
      return res;
    },
    deleteProperty: function (target, key) {
      var had = Object.prototype.hasOwnProperty.call(target, key);
      var res = Reflect.deleteProperty(target, key);
      if (had && res) { trigger(target, ITERATE_KEY); trigger(target, key); }
      return res;
    },
    has: function (target, key) {
      if (typeof key !== 'symbol') track(target, key); // 支持 'x' in obj 的依赖收集
      return Reflect.has(target, key);
    },
    ownKeys: function (target) {
      track(target, ITERATE_KEY); // 支持 for...in / Object.keys 感知新增成员
      return Reflect.ownKeys(target);
    }
  };

  // 把对象包装成响应式代理：已代理则直接复用；不支持 Proxy 的环境退化为普通对象（仅失去响应式）
  function toReactive(value) {
    if (!isObject(value)) return value;
    if (proxyToRaw && proxyToRaw.has(value)) return value;
    if (!hasNativeProxy || !rawToProxy) return value;
    var cached = rawToProxy.get(value);
    if (cached) return cached;
    var proxy = new Proxy(value, reactiveHandlers);
    rawToProxy.set(value, proxy);
    proxyToRaw.set(proxy, value);
    return proxy;
  }

  // 兼容旧调用点：返回的代理需由调用方用返回值替换原引用（见 _init）
  function observe(value) {
    return toReactive(value);
  }

  // 取回响应式代理背后的原始对象：便于调试、引用比较，或在需要绕过代理时拿到底层数据。
  Vue.toRaw = function (proxy) {
    if (proxyToRaw && proxyToRaw.has(proxy)) return proxyToRaw.get(proxy);
    return proxy;
  };

  /* ==================== 4. 表达式取值/赋值 ==================== */
  function getValue(vm, exp, scope) {
    exp = String(exp == null ? '' : exp).trim();
    if (exp === '') return '';
    var info = getPathInfo(exp);
    // 简单路径：用预解析好的段信息，避免每次重复正则匹配与 split
    if (info.simple) {
      var segs = info.segs, first = segs[0];
      // 用 hasOwnProperty 精确判断，避免 top 层 key（如 toString）沿原型链被误判为数据项
      if (scope && Object.prototype.hasOwnProperty.call(scope, first)) return readSegs(scope, segs);
      if (Object.prototype.hasOwnProperty.call(vm.$data, first)) return readSegs(vm.$data, segs);
      if (Object.prototype.hasOwnProperty.call(vm.$computed, first)) return readSegs(vm.$computed, segs);
      return readSegs(vm, segs);
    }
    // 复杂表达式
    return evalExp(vm, exp, scope);
  }

  function setValue(vm, path, val, scope) {
    var seg = String(path).split('.');
    var root = scope && seg[0] in scope ? scope
      : (seg[0] in vm.$data ? vm.$data
        : (seg[0] in vm.$computed ? vm.$computed : vm));
    var cur = root;
    for (var i = 0; i < seg.length - 1; i++) {
      if (cur == null) return;
      var mid = cur[seg[i]];
      // 中间路径缺失或已退化为原始值（undefined/非对象）时补一个对象以继续深入；
      // 注意 null 的 typeof 是 'object'，故此处不覆盖 null，沿用原逻辑（中断深入）。
      if (mid === undefined || typeof mid !== 'object') { mid = {}; cur[seg[i]] = mid; }
      cur = mid;
    }
    if (cur != null) cur[seg[seg.length - 1]] = val;
  }

  // 简单路径解析信息缓存：把"切分 + 是否简单点路径"的判断从每次取值时重复执行改为只算一次，
  // 覆盖 getValue / read 这两个所有绑定的公共高频入口
  var pathInfoCache = {};
  function getPathInfo(exp) {
    var info = pathInfoCache[exp];
    if (!info) {
      info = {
        segs: exp.split('.'),
        simple: /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(exp)
      };
      lruSet(pathInfoCache, exp, info);
    }
    return info;
  }
  function readSegs(obj, segs) {
    var cur = obj;
    for (var i = 0; i < segs.length; i++) { if (cur == null) return undefined; cur = cur[segs[i]]; }
    return cur;
  }
  function read(obj, path) {
    return readSegs(obj, getPathInfo(path).segs);
  }

  var CACHE_MAX = 300;
  // 简易 FIFO 淘汰：对象键按插入顺序，缓存满后删除最早插入的键，避免任意页缓存无限增长
  // 用 WeakMap 计数代替每次插入都 Object.keys 全量枚举，把"是否已满"的判断从 O(n) 降到 O(1)
  var cacheSizes = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function lruSet(cache, key, val) {
    if (cache[key] == null) {
      var size = 0;
      if (cacheSizes) size = cacheSizes.get(cache) || 0;
      else size = Object.keys(cache).length; // 无 WeakMap 时回退到全量统计
      if (size >= CACHE_MAX) {
        for (var k in cache) { delete cache[k]; break; }
      } else {
        if (cacheSizes) cacheSizes.set(cache, size + 1);
      }
      cache[key] = val;
    } else {
      cache[key] = val; // 覆盖已有 key：缓存大小不变
    }
  }

  // 表达式编译结果缓存：key 带参数名列表，保证不同 vm/scope 上下文互不串用
  var expCache = {};
  // scope 的 key 列表缓存（WeakMap 防泄漏：scope 引用稳定，每个 scope 只枚举一次）
  var scopeKeyCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  // 汇总某实例 + 作用域下用作表达式自由变量的 key 列表。
  // vm 实例级 data/computed 的 key 在初始化后结构稳定，缓存避免每次求值都 Object.keys + filter 全量枚举。
  // 注意：运行时通过 $data 新增的属性在"简单路径"下仍能被 getValue 动态读到（hasOwnProperty 实时判断），
  // 仅在"复杂表达式把新属性当自由变量"这一少见场景下不在作用域内，属可接受的取舍。
  function compiledKeys(vm, scope) {
    var dataKeys, compKeys;
    if (vm._exprDataKeys) dataKeys = vm._exprDataKeys;
    else { dataKeys = Object.keys(vm.$data).filter(isId); vm._exprDataKeys = dataKeys; }
    if (vm._exprCompKeys) compKeys = vm._exprCompKeys;
    else { compKeys = Object.keys(vm.$computed).filter(isId); vm._exprCompKeys = compKeys; }
    var scopeKeys = [];
    if (scope) {
      if (scopeKeyCache) {
        var c = scopeKeyCache.get(scope);
        if (c) scopeKeys = c;
        else { scopeKeys = Object.keys(scope).filter(isId); scopeKeyCache.set(scope, scopeKeys); }
      } else {
        scopeKeys = Object.keys(scope).filter(isId);
      }
    }
    return { d: dataKeys, c: compKeys, s: scopeKeys };
  }
  function evalExp(vm, exp, scope) {
    var k = compiledKeys(vm, scope);
    var all = dedupe(k.s.concat(k.d).concat(k.c));
    var args = all.map(function (key) {
      if (scope && key in scope) return scope[key];
      if (key in vm.$data) return vm.$data[key];
      return vm.$computed[key];
    });
    var cacheKey = exp + '\u0000' + all.join(',');
    var fn = expCache[cacheKey];
    if (!fn) {
      try { fn = new Function(all.join(','), 'return (' + exp + ');'); lruSet(expCache, cacheKey, fn); }
      catch (e) { handleError(vm, e, '表达式错误: ' + exp); return undefined; }
    }
    return fn.apply(null, args);
  }
  function isId(k) { return /^[A-Za-z_$][\w$]*$/.test(k); }
  function dedupe(arr) { var seen = {}, out = []; arr.forEach(function (x) { if (!seen[x]) { seen[x] = 1; out.push(x); } }); return out; }

  /* ==================== 5. 模板编译 ==================== */
  var tagRE = /\{\{((?:.|\r?\n)+?)\}\}/g;

  function compileNode(node, vm, scope) {
    if (node.nodeType === 8) return; // 注释
    if (node.nodeType === 3) {
      compileText(node, vm, scope);
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') {
      return;
    }
    compileElement(node, vm, scope);
  }

  function compileTree(root, vm, scope) {
    walk(root, vm, scope);
  }

  function walk(node, vm, scope) {
    var child = node.firstChild;
    while (child) {
      var next = child.nextSibling;
      compileNode(child, vm, scope);
      child = next;
    }
  }

  /* ---- 文本节点插值 ---- */
  var textParseCache = {};
  function compileText(node, vm, scope) {
    var text = node.textContent;
    if (text.indexOf('{{') === -1) return;
    var tokens = textParseCache[text];
    if (!tokens) {
      tokens = [];
      var last = 0, m;
      tagRE.lastIndex = 0;
      while ((m = tagRE.exec(text))) {
        if (m.index > last) tokens.push(text.slice(last, m.index));
        tokens.push({ exp: m[1].trim() });
        last = m.index + m[0].length;
      }
      if (last < text.length) tokens.push(text.slice(last));
      lruSet(textParseCache, text, tokens);
    }

    var render = function () {
      var out = '';
      for (var i = 0; i < tokens.length; i++) {
        var t = tokens[i];
        if (typeof t === 'object') out += stringify(getValue(vm, t.exp, scope));
        else out += t;
      }
      return out;
    };
    // 用一个渲染型 Watcher：getter 读 render 会收集所有依赖；
    // lazyInit 让构造时不求值，由下方首次 run() 一次性完成依赖收集+求值+写 DOM（避免重复求值）
    function update() { node.textContent = render(); }
    var watch = new Watcher(vm, function () { return render(); }, update, { lazyInit: true });
    watch.run();
  }

  function stringify(val) {
    if (val === null || val === undefined) return '';
    if (typeof val === 'object') { try { return JSON.stringify(val); } catch (e) { return String(val); } }
    return String(val);
  }

  /* ---- 元素节点指令 ---- */
  var dirRE = /^(v-|:|@)/;
  var onRE = /^(v-on:|@)/;
  var bindRE = /^(v-bind:|:)/;
  var modelRE = /^v-model/;
  var ifRE = /^v-if/;
  var showRE = /^v-show/;
  var forRE = /^v-for/;
  var textRE = /^v-text/;
  var htmlRE = /^v-html/;

  function parseFor(exp) {
    var inMatch = exp.match(/^\s*(.*?)\s+(?:in|of)\s+(.*)\s*$/);
    if (!inMatch) return null;
    var left = inMatch[1].trim();
    var m2 = left.match(/^(?:\(([^)]*)\)|([^\s]+))$/);
    var ids = [];
    if (m2) {
      var rawIds = (m2[1] || m2[2]).split(',').map(function (s) { return s.trim(); });
      ids = rawIds;
    }
    return {
      alias: ids[0] || '',
      index: ids[1] || '',
      key: ids[2] || '',
      value: inMatch[2].trim()
    };
  }

  function watchEffect(vm, fn) {
    // getter 执行 fn 完成一次渲染并收集依赖（fn 内部写 DOM 属于副作用），cb 用 noop 占位，
    // 数据变化时 run() 的 get() 会再次调用 fn；相比 new Watcher(vm,fn,fn)+fn() 避免了初始化双写。
    new Watcher(vm, function () { fn(); }, noop);
  }
  // v-html 安全开关：仅当 Vue.config.html === true 时才允许写入原始 HTML。
  // 默认关闭 —— 未开启时 v-html 降级为纯文本输出（textContent），防止数据被当作 HTML/脚本解析（XSS）。
  // {{ }} 与 v-text 本就写 textContent，天然安全，不受此开关影响。
  var htmlAllowedWarned = false;
  function htmlAllowed() {
    var cfg = Vue && Vue.config;
    var on = !!(cfg && cfg.html);
    if (!on && !htmlAllowedWarned) {
      htmlAllowedWarned = true;
      warn('v-html 未启用（Vue.config.html 默认 false）。已降级为纯文本输出，避免 HTML 注入；确需渲染请显式设置 Vue.config.html = true。');
    }
    return on;
  }
  function bindText(node, vm, exp, scope, html) {
    watchEffect(vm, function upd() {
      var v = stringify(getValue(vm, exp, scope));
      if (html && htmlAllowed()) node.innerHTML = v;
      else node.textContent = v;
    });
  }

  function compileElement(node, vm, scope) {
    // v-pre：跳过整个子树的编译（指令 + 插值都保留为原样），通常用于含大量静态内容避免解析开销
    if (node.hasAttribute && node.hasAttribute('v-pre')) { node.removeAttribute('v-pre'); return; }
    // v-cloak：编译完成后移除，避免插值编译前闪现（配合 CSS [v-cloak]{display:none}）
    if (node.hasAttribute && node.hasAttribute('v-cloak')) node.removeAttribute('v-cloak');
    var attrs = Array.prototype.slice.call(node.attributes);

    // 收集指令
    var dirFor = null, dirIf = '', dirShow = '';

    for (var i = 0; i < attrs.length; i++) {
      var a = attrs[i];
      var nm = a.name;
      if (forRE.test(nm)) dirFor = parseFor(a.value);
      else if (ifRE.test(nm)) dirIf = a.value.trim();
      else if (showRE.test(nm)) dirShow = a.value.trim();
    }

    if (dirFor) { compileFor(node, vm, scope, dirFor); return; }

    // v-else / v-else-if 单独出现（没有配对的 v-if）时不做渲染，直接移除
    if (hasElseDirective(node)) {
      if (node.parentNode) node.parentNode.removeChild(node);
      return;
    }

    if (dirIf !== '') { compileIf(node, vm, scope, dirIf); return; }

    // 普通元素：处理属性指令 + 收集 ref
    var toRemove = []; // 需移除的指令属性名（单次扫描记录，避免二次遍历 attributes）
    for (var j = 0; j < attrs.length; j++) {
      var attr = attrs[j];
      var name = attr.name;
      var value = attr.value.trim();

      if (dirRE.test(name)) toRemove.push(name);
      if (modelRE.test(name)) {
        // 解析 v-model 修饰符（从属性名里取，如 v-model.number / v-model.trim / v-model.lazy）
        var modelMods = name.replace(/^v-model/, '').split('.').filter(Boolean);
        bindModel(node, vm, value, scope, modelMods);
        continue;
      }
      if (onRE.test(name)) { bindEvent(node, vm, name.replace(onRE, ''), value); continue; }
      if (bindRE.test(name)) {
        var bname = name.replace(bindRE, '');
        if (bname === 'key') continue; // v-for 的 :key 是元信息，不写入 DOM 属性
        bindAttr(node, vm, bname, value, scope);
        continue;
      }
      if (textRE.test(name)) { bindText(node, vm, value, scope, false); continue; }
      if (htmlRE.test(name)) { bindText(node, vm, value, scope, true); continue; }
    }
    // 移除所有 v- / : / @ 指令属性（保留普通属性）
    for (var k = 0; k < toRemove.length; k++) node.removeAttribute(toRemove[k]);

    // v-show
    if (dirShow !== '') {
      watchEffect(vm, function updShow() { node.style.display = getValue(vm, dirShow, scope) ? '' : 'none'; });
    }

    // ref 注册：普通元素直接赋 DOM；v-for 子项内则并入数组，方便取节点集合
    var refName = node.getAttribute && node.getAttribute('ref');
    if (refName) {
      if (currentGroup()) {
        if (!vm.$refs[refName]) vm.$refs[refName] = [];
        vm.$refs[refName].push(node);
      } else {
        vm.$refs[refName] = node;
      }
      node.removeAttribute('ref');
    }

    // 递归子节点
    walk(node, vm, scope);
  }

  /* ---- v-on / 事件 ---- */
  /* ---- 事件监听登记：供 $destroy / v-for 回收时统一解绑，避免闭包泄漏 ---- */
  var nodeListeners = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function bindListener(vm, node, event, fn, opts) {
    var capture = !!(opts && opts.capture);
    var passive = !!(opts && opts.passive);
    var flags = (capture || passive) ? { capture: capture, passive: passive } : undefined;
    node.addEventListener(event, fn, flags);
    if (!nodeListeners || !node) return;
    var arr = nodeListeners.get(node);
    if (!arr) { arr = []; nodeListeners.set(node, arr); }
    arr.push([event, fn, capture]);
    // 记录节点到实例，方便 $destroy 遍历清理
    if (vm && vm._boundNodes && vm._boundNodes.indexOf(node) === -1) vm._boundNodes.push(node);
  }
  function unbindNode(node, vm) {
    if (!nodeListeners || !node) return;
    var arr = nodeListeners.get(node);
    if (arr) {
      for (var i = 0; i < arr.length; i++) node.removeEventListener(arr[i][0], arr[i][1], !!arr[i][2]);
      nodeListeners.delete(node);
    }
    // 同步移除实例登记引用，避免收集 detached 节点到 $destroy（幂等且已解散绑的节点也清理）
    if (vm && vm._boundNodes) {
      var idx = vm._boundNodes.indexOf(node);
      if (idx > -1) vm._boundNodes.splice(idx, 1);
    }
  }
  function unbindAllListeners(vm) {
    var nodes = vm._boundNodes.slice();
    for (var i = 0; i < nodes.length; i++) unbindNode(nodes[i], vm);
    vm._boundNodes = [];
  }
  // 递归解绑整棵子树上登记过的事件监听（用于 v-if 切换分支时回收脱离文档的子树）
  function unbindTree(node, vm) {
    if (node.nodeType === 1) unbindNode(node, vm);
    var child = node.firstChild;
    while (child) { unbindTree(child); child = child.nextSibling; }
  }

  function bindEvent(node, vm, eventSpec, handlerExp) {
    // 解析事件名与修饰符：@click.stop.prevent、@keydown.enter ...
    var parts = eventSpec.split('.');
    var eventName = parts[0];
    var mods = parts.slice(1);
    var hasOnce = mods.indexOf('once') > -1;
    var hasPrevent = mods.indexOf('prevent') > -1;
    var hasStop = mods.indexOf('stop') > -1;
    var hasSelf = mods.indexOf('self') > -1;
    var hasCapture = mods.indexOf('capture') > -1;
    var hasPassive = mods.indexOf('passive') > -1;
    var hasExact = mods.indexOf('exact') > -1;
    var btnMods = ['left', 'right', 'middle'].filter(function (m) { return mods.indexOf(m) > -1; });
    // 系统键修饰：.ctrl/.shift/.alt/.meta（对任意事件生效，如 ctrl+click），从 mods 中剔除以免污染键盘 keycode 匹配
    var sysKeys = ['ctrl', 'shift', 'alt', 'meta'];
    var sysMods = sysKeys.filter(function (m) { return mods.indexOf(m) > -1; });
    var flagMods = ['capture', 'passive', 'exact'];
    mods = mods.filter(function (m) { return sysKeys.indexOf(m) === -1 && flagMods.indexOf(m) === -1; });
    // 鼠标键修饰：click 事件的 e.button 在部分浏览器（如 Firefox）恒为 0，无法区分左/中/右键；
    // 带 .left/.right/.middle 且原事件是 click 时，改监听 mousedown（e.button 跨浏览器可靠）来精准判定。
    var bindEventName = (btnMods.length > 0 && eventName === 'click') ? 'mousedown' : eventName;

    function rawHandler(e) {
      try {
        // 方法形式：直接以实例为 this 调用
        if (typeof vm[handlerExp] === 'function') { vm[handlerExp](e); return; }
        // 内联表达式形式：with(vm) 把 data / computed / methods 都暴露到求值作用域，
        // 通过 vm 代理的 getter/setter 保证 count++ 这类写操作能正确回写数据；
        // 编译结果按 handlerExp 缓存，避免高频事件每次触发都 new Function
        var fn = getEventFn(vm, handlerExp);
        fn(vm, e);
      } catch (err) { handleError(vm, err, '事件处理出错: ' + handlerExp); }
    }

    var wrapper = function (e) {
      // .self：仅当事件目标就是当前元素时才触发
      if (hasSelf && e.target !== node) return;
      // .left / .right / .middle：仅当是鼠标事件时按鼠标键过滤；
      // 若绑定在键盘事件（如 @keydown.left）则交给下方键码别名处理，避免误判方向键不触发
      if (btnMods.length && e.type.indexOf('mouse') === 0 && !isBtnMatched(e, btnMods)) return;
      // .ctrl/.shift/.alt/.meta：默认要求所列系统键按下（其他键不限）；
      // .exact 时要求恰好等于所列组合，多按任意一个其他系统键都不触发
      if (sysMods.length) {
        if (hasExact ? !isSysExact(e, sysMods) : !isSysMatched(e, sysMods)) return;
      } else if (hasExact) {
        // 仅 .exact 无任何系统键：要求四个系统键全部未按下
        if (e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
      }
      if (hasPrevent && e.preventDefault) e.preventDefault();
      if (hasStop && e.stopPropagation) e.stopPropagation();
      // 键盘修饰符（.enter / .esc / .tab / .up ... 或具体键码数字）
      if (mods.length && e.type.indexOf('key') === 0 && !isKeyMatched(e, mods)) return;
      rawHandler(e);
      if (hasOnce) node.removeEventListener(bindEventName, wrapper);
    };
    bindListener(vm, node, bindEventName, wrapper, { capture: hasCapture, passive: hasPassive });
  }

  function isBtnMatched(e, mods) {
    // button: 0=左键 1=中键 2=右键
    var map = { left: 0, middle: 1, right: 2 };
    return mods.some(function (m) { return e.button === map[m]; });
  }

  function isSysMatched(e, sys) {
    // 逐项校验：要求对应布尔键为真；未在修饰符中列出的系统键不做约束
    for (var i = 0; i < sys.length; i++) {
      var k = sys[i];
      if ((k === 'ctrl' && !e.ctrlKey) || (k === 'shift' && !e.shiftKey) ||
          (k === 'alt' && !e.altKey) || (k === 'meta' && !e.metaKey)) return false;
    }
    return true;
  }

  function isSysExact(e, sys) {
    // .exact：要求恰好按下列出的系统键；多按任意一个未列出的系统键即视为不匹配
    var map = { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey };
    for (var k in map) {
      var required = sys.indexOf(k) > -1;
      if (required !== !!map[k]) return false;
    }
    return true;
  }

  function isKeyMatched(e, mods) {
    var keyAlias = {
      enter: 13, tab: 9, esc: 27, escape: 27, space: 32, up: 38, down: 40,
      left: 37, right: 39, backspace: 8, delete: 46, insert: 45,
      '0': 48, '1': 49, '2': 50, '3': 51, '4': 52, '5': 53,
      '6': 54, '7': 55, '8': 56, '9': 57
    };
    var relevant = mods.filter(function (m) { return m !== 'stop' && m !== 'prevent' && m !== 'once'; });
    if (!relevant.length) return true;
    // 键盘别名可能有 .enter 等 a-b 写法；这里做基础匹配
    return relevant.some(function (m) {
      if (m in keyAlias) {
        var code = keyAlias[m];
        return Array.isArray(code) ? code.indexOf(e.keyCode) > -1 : e.keyCode === code;
      }
      if (/^\d{1,3}$/.test(m)) return e.keyCode === Number(m);
      return e.key === m;
    });
  }
  function handlerCompile(s) {
    // 把 this.xxx 指向 vm.xxx；with(vm) 后再配合它能解析到实例
    s = s.replace(/this\./g, 'vm.');
    return s;
  }
  // 事件内联表达式编译结果缓存：key 即原始 handlerExp（产物只依赖 handlerExp 与固定的 vm/$event 形参）。
  // 复用 lruSet 的 FIFO 上限淘汰，避免任意页面事件表达式无限累积。
  var eventFnCache = {};
  function getEventFn(vm, handlerExp) {
    var fn = eventFnCache[handlerExp];
    if (!fn) {
      var exp = 'with(vm){ return (' + handlerCompile(handlerExp) + '); }';
      fn = new Function('vm', '$event', exp);
      lruSet(eventFnCache, handlerExp, fn);
    }
    return fn;
  }

  /* ---- v-bind ---- */
  function bindAttr(node, vm, attrName, exp, scope) {
    // 记录静态 class 用于与动态值合并；静态 style 由浏览器原生常驻，动态 style 按属性增量写入（不整块覆盖，避免擦掉 v-show 的 display）
    var statClass = node.getAttribute && node.getAttribute('class') || '';
    var lastStyleProps = null;

    function apply() {
      var val = getValue(vm, exp, scope);
      if (attrName === 'style') {
        var map = stylePropMap(val);
        // 清掉上一轮本指令已写入、但本轮不再出现的样式属性
        if (lastStyleProps) {
          for (var p in lastStyleProps) if (!(p in map)) node.style[p] = '';
        }
        for (var q in map) node.style[q] = map[q];
        lastStyleProps = map;
      } else if (attrName === 'class') {
        var dynC = stringify(toClass(val));
        node.className = trimJoin(statClass, dynC);
      } else if (val === false || val === null || val === undefined) {
        node.removeAttribute(attrName);
      } else {
        node.setAttribute(attrName, stringify(val));
      }
    }
    new Watcher(vm, function () { return getValue(vm, exp, scope); }, apply);
    apply();
  }
  function stylePropMap(val) {
    // 把 :style 值解析成 {camelStyleProp: value} 映射，支持字符串 / 数组 / 对象三种写法
    var map = {};
    function put(k, v) { if (v != null && v !== '') map[camelize(k)] = v; }
    function putObj(o) { if (!o || typeof o !== 'object') return; Object.keys(o).forEach(function (k) { put(k, o[k]); }); }
    if (typeof val === 'string') {
      val.split(';').forEach(function (decl) {
        var i = decl.indexOf(':');
        if (i > -1) put(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
      });
    } else if (Array.isArray(val)) {
      val.forEach(function (it) {
        if (it && typeof it === 'object') putObj(it);
        else if (typeof it === 'string') { var i = it.indexOf(':'); if (i > -1) put(it.slice(0, i).trim(), it.slice(i + 1).trim()); }
      });
    } else {
      putObj(val);
    }
    return map;
  }
  function camelize(s) { return s.replace(/-(\w)/g, function (_, c) { return c ? c.toUpperCase() : ''; }); }
  function trimJoin(a, b) {
    a = (a || '').replace(/^\s+|\s+$/g, '');
    b = (b || '').replace(/^\s+|\s+$/g, '');
    if (!a) return b;
    if (!b) return a;
    return a + ' ' + b;
  }
  function toClass(val) {
    if (typeof val === 'string') return val;
    if (Array.isArray(val)) return val.join(' ');
    if (val && typeof val === 'object') {
      var out = [];
      Object.keys(val).forEach(function (k) { if (val[k]) out.push(k); });
      return out.join(' ');
    }
    return val;
  }
  /* ---- v-model ---- */
  function bindModel(node, vm, path, scope, mods) {
    mods = mods || [];
    var tag = node.tagName.toLowerCase();
    // 修饰符转换器：.number 转数字、.trim 去首尾空格
    function toVal(str) {
      if (mods.indexOf('trim') > -1) str = str.trim();
      if (mods.indexOf('number') > -1) {
        if (str === '') return '';
        var n = parseFloat(str);
        return isNaN(n) ? str : n;
      }
      return str;
    }
    if (tag === 'select') return bindModelSelect(node, vm, path, scope);
    // true-value / false-value：单个 checkbox 在此值生效/取消时写入指定静态值
    var trueVal = node.getAttribute && node.getAttribute('true-value');
    var falseVal = node.getAttribute && node.getAttribute('false-value');
    if (node.type === 'checkbox') {
      bindListener(vm, node, 'change', function () {
        var cur = getValue(vm, path, scope);
        if (Array.isArray(cur)) {
          // 复选框数组：勾选新增 / 取消移除，均构造成新数组整体写回，
          // 不原地 splice 原数组，避免对已观察数组的中间态再派发一次更新
          var idx = cur.indexOf(node.value);
          var next;
          if (node.checked && idx === -1) next = cur.concat(node.value);
          else if (!node.checked && idx > -1) next = cur.slice(0, idx).concat(cur.slice(idx + 1));
          else return; // 无需变更
          setValue(vm, path, next, scope);
        } else {
          setValue(vm, path, node.checked ? (trueVal !== null ? trueVal : true) : (falseVal !== null ? falseVal : false), scope);
        }
      });
    } else if (node.type === 'radio') {
      bindListener(vm, node, 'change', function () {
        if (node.checked) setValue(vm, path, node.value, scope);
      });
    } else {
      // .lazy 改为 change 触发，否则用 input（默认）
      var listenEvent = mods.indexOf('lazy') > -1 ? 'change' : 'input';
      bindListener(vm, node, listenEvent, function () { setValue(vm, path, toVal(node.value), scope); });
      if (listenEvent === 'input') {
        bindListener(vm, node, 'change', function () { setValue(vm, path, toVal(node.value), scope); });
      }
    }
    function update() {
      var val = getValue(vm, path, scope);
      var v = val === null || val === undefined ? '' : val;
      if (node.type === 'checkbox') {
        if (Array.isArray(v)) node.checked = v.indexOf(node.value) > -1;
        else node.checked = v === trueVal || (!trueVal && !!v);
      } else if (node.type === 'radio') node.checked = String(v) === node.value;
      else node.value = String(v);
    }
    // getter 只读值收集依赖，cb 负责写 DOM，避免初始化阶段双写
    new Watcher(vm, function () { return getValue(vm, path, scope); }, update);
    update();
  }
  function bindModelSelect(node, vm, path, scope) {
    bindListener(vm, node, 'change', function () { setValue(vm, path, node.value, scope); });
    function update() {
      var v = getValue(vm, path, scope);
      node.value = v === null || v === undefined ? '' : String(v);
    }
    new Watcher(vm, function () { return getValue(vm, path, scope); }, update);
    update();
  }

  /* ---- v-if / v-else-if / v-else ---- */
  function compileIf(node, vm, scope, exp) {
    var parent = node.parentNode;

    // 收集整条 if 分支链：v-if -> v-else-if* -> v-else（跳过中间的空白文本/注释）
    var branches = [{ node: node, cond: exp }];
    var cur = node.nextSibling;
    while (true) {
      cur = skipWhitespaceAndComments(cur);
      if (!cur || cur.nodeType !== 1) break;
      if (cur.hasAttribute && (cur.hasAttribute('v-else') || cur.hasAttribute('v-else-if'))) {
        branches.push({ node: cur, cond: cur.getAttribute('v-else-if') || '' });
        cur = cur.nextSibling;
      } else break;
    }

    // 为每个分支生成"无指令"的模板副本，并在原位置安放锚点注释
    // 必须剥掉 v-if/v-else-if/v-else，否则渲染后又会被误判为条件分支
    branches.forEach(function (b) {
      b.tpl = b.node.cloneNode(true);
      removeAttrs(b.tpl, ['v-if', 'v-else-if', 'v-else']);
      b.anchor = document.createComment(' v-if ');
      parent.insertBefore(b.anchor, b.node);
      parent.removeChild(b.node);
      b.group = []; // 该分支渲染产生的 watcher 分组，供切换分支时统一回收
    });

    var rendered = null;       // 当前渲染出的分支节点
    var renderedGroup = null;  // 该分支编译产生的 watcher 分组

    function render() {
      // 从第一个分支开始，命中第一个条件为真的分支（v-else 无条件命中）
      var chosen = null;
      for (var i = 0; i < branches.length; i++) {
        var b = branches[i];
        if (b.cond === '' || !!getValue(vm, b.cond, scope)) { chosen = b; break; }
      }
      // 切换/回收上一分支：先 teardown 其 watcher，再解绑子树事件并移除 DOM，
      // 避免已脱离文档的分支仍订阅数据、持续更新幽灵节点（与 v-for 的分组回收一致）
      if (rendered) {
        for (var g = 0; g < renderedGroup.length; g++) renderedGroup[g].teardown();
        if (rendered.nodeType === 1) unbindTree(rendered, vm);
        rendered.parentNode.removeChild(rendered);
        renderedGroup.length = 0;
      }
      rendered = null; renderedGroup = null;
      if (chosen) {
        rendered = chosen.tpl.cloneNode(true);
        renderedGroup = [];
        parent.insertBefore(rendered, chosen.anchor.nextSibling);
        // 编译期间新建的 watcher 并入该分支分组，切换时随分支一起回收
        watcherGroupStack.push(renderedGroup);
        try { compileTree(rendered, vm, scope); }
        finally { watcherGroupStack.pop(); }
      }
    }

    // getter 先遍历求值所有分支条件以收集各分支依赖（不靠返回布尔判断），
    // 返回每次都是新对象的哨兵，保证 run() 恒触发 render（纯布尔比较在分支间
    // 相互切换时可能判等而漏渲染）
    new Watcher(vm, function () {
      for (var i = 0; i < branches.length; i++) {
        if (branches[i].cond !== '') getValue(vm, branches[i].cond, scope);
      }
      return { render: true };
    }, render);
    render();
  }

  function hasElseDirective(node) {
    if (!node || node.nodeType !== 1) return false;
    return node.hasAttribute && (node.hasAttribute('v-else') || node.hasAttribute('v-else-if'));
  }

  // 跳过纯空白文本节点与注释节点
  function skipWhitespaceAndComments(node) {
    var n = node;
    while (n && (n.nodeType === 8 || (n.nodeType === 3 && n.textContent.trim() === ''))) {
      n = n.nextSibling;
    }
    return n;
  }

  function removeAttrs(node, names) {
    names.forEach(function (name) {
      if (node && node.hasAttribute && node.hasAttribute(name)) node.removeAttribute(name);
    });
  }

  /* ---- v-for ---- */
  function compileFor(node, vm, scope, info) {
    if (!info.alias || !info.value) return;
    var parent = node.parentNode;

    var origin = node.cloneNode(true);

    // ref：v-for 元素的 ref 应收起为节点数组（每个渲染项一份），这里在 origin 上取并移除，逐个 clone 时再登记
    var refName = node.getAttribute('ref');
    if (refName) origin.removeAttribute('ref');
    // :key 表达式（仅用于列表复用定位，不写入 DOM；缺省则退回按位置复用）
    var keyExp = node.getAttribute(':key') || node.getAttribute('v-bind:key');

    // 固定锚点：v-for 产出都插在它前面，标记渲染位置且避免每次重建锚点
    var anchor = document.createComment(' v-for-end ');
    parent.insertBefore(anchor, node);
    parent.removeChild(node);

    var norm = [];    // 当前归一化列表（渲染期间共享，供各作用域 getter 即时读取）
    var nodes = [];   // 每个索引对应的 DOM 节点
    var groups = [];  // 每个节点编译产生的 watcher 分组，用于复用/回收
    var slots = [];   // 每个节点的可编辑位置槽 { i }
    var objs = [];    // 每个节点上一次渲染绑定的 item 对象（用于判断是否需重跑 watcher）
    var keys = [];    // 每个节点当前绑定的 :key 值（供 key 复用定位）

    function entry(i) { return norm[i]; }

    // 延迟作用域：getter 通过 slot.i 读取当前 norm[slot.i]
    function makeScope(slot) {
      var s = Object.create(scope || null);
      Object.defineProperty(s, info.alias, {
        configurable: true, enumerable: true,
        get: function () { var e = entry(slot.i); return e ? e.value : undefined; }
      });
      if (info.index) Object.defineProperty(s, info.index, {
        configurable: true, enumerable: true,
        get: function () { var e = entry(slot.i); return e ? e.index : slot.i; }
      });
      if (info.key) Object.defineProperty(s, info.key, {
        configurable: true, enumerable: true,
        get: function () { var e = entry(slot.i); return e ? e.key : undefined; }
      });
      Object.defineProperty(s, '$index', {
        configurable: true, enumerable: false,
        get: function () { return slot.i; }
      });
      return s;
    }

    // 在锚点前追加/编译一个新节点，绑定到位置 pos 的槽 slot
    function addNode(pos, slot, tNodes, tGroups, tSlots) {
      var clone = origin.cloneNode(true);
      // 收集 v-for 出的 ref（累积进数组，顺序即渲染顺序）
      if (refName) {
        if (!vm.$refs[refName]) vm.$refs[refName] = [];
        vm.$refs[refName].push(clone);
      }
      var childScope = makeScope(slot);
      var g2 = [];
      parent.insertBefore(clone, anchor);
      watcherGroupStack.push(g2);
      try {
        compileTree(clone, vm, childScope);
      } finally {
        watcherGroupStack.pop();
      }
      // 写入目标数组：默认写共享数组（按位置复用场景）；key 复用场景传入临时数组，
      // 避免在组装新列表期间与仍待回收的旧索引混写
      tNodes = tNodes || nodes;
      tGroups = tGroups || groups;
      tSlots = tSlots || slots;
      tNodes[pos] = clone;
      tGroups[pos] = g2;
      tSlots[pos] = slot;
    }

    function runGroup(k) {
      var gl = groups[k];
      for (var w = 0; w < gl.length; w++) gl[w].run();
    }

    function teardownAt(k) {
      var g = groups[k];
      for (var t = 0; t < g.length; t++) g[t].teardown();
      unbindNode(nodes[k], vm);
      parent.removeChild(nodes[k]);
      if (refName && vm.$refs[refName]) {
        var arr = vm.$refs[refName];
        var idx = arr.indexOf(nodes[k]);
        if (idx > -1) arr.splice(idx, 1);
      }
    }

    // ---- 索引模式：按位置复用，未提供 :key 时的兜底 ----
    function renderByIndex(newNorm) {
      var oldLen = nodes.length;
      var newLen = newNorm.length;
      var reuse = oldLen < newLen ? oldLen : newLen;

      for (var i = oldLen - 1; i >= newLen; i--) teardownAt(i);
      nodes.length = newLen; groups.length = newLen; slots.length = newLen; objs.length = newLen;

      norm = newNorm;
      for (var j = reuse; j < newLen; j++) {
        addNode(j, { i: j });
        objs[j] = newNorm[j].value;
      }
      // 复用节点：slot.i 恒等于位置 i 不变；仅当 item 对象变化才重跑
      for (var k = 0; k < reuse; k++) {
        if (objs[k] === newNorm[k].value) continue;
        runGroup(k);
        objs[k] = newNorm[k].value;
      }
    }

    // ---- :key 模式：按 key 复用节点，重排时保留内部状态（输入框/事件等不重建）----
    // 依据提供的 key 表达式为每个新列表项求得 key；norm 已先切换为新列表，
    // 使 makeScope 的 item getter 能读到新项以计算 key（一般为 item.id 之类）。
    function computeKeys() {
      var out = new Array(norm.length);
      for (var i = 0; i < norm.length; i++) out[i] = getValue(vm, keyExp, makeScope({ i: i }));
      return out;
    }
    function renderByKey(newKeys) {
      var newLen = newKeys.length;
      // 旧节点按 key 索引（同名 key 取最早）
      var oldByKey = {};
      for (var i = 0; i < keys.length; i++) if (!(keys[i] in oldByKey)) oldByKey[keys[i]] = i;
      var used = {};
      // 用临时数组组装新列表：期间不改写共享 nodes，避免与待回收的旧索引冲突
      var tNodes = new Array(newLen), tGroups = new Array(newLen), tSlots = new Array(newLen);
      var tObjs = new Array(newLen), tKeys = new Array(newLen);

      for (var j = 0; j < newLen; j++) {
        var key = newKeys[j];
        var oi = (key in oldByKey && !used[oldByKey[key]]) ? oldByKey[key] : -1;
        if (oi > -1) {
          // 复用节点：把它的槽位更新到新位置。注意即使 item 对象未变也必须重跑内部 watcher，
          // 因为位置相关的绑定（{{i}}、$index 等）需要随移动到的新下标刷新；重跑仅按数据重写
          // 文本/属性，不会重置例如输入框这类未发生变化的 DOM 状态。
          slots[oi].i = j;
          runGroup(oi);
          tNodes[j] = nodes[oi]; tGroups[j] = groups[oi]; tSlots[j] = slots[oi];
          tObjs[j] = norm[j].value; tKeys[j] = key;
          used[oi] = true;
        } else {
          addNode(j, { i: j }, tNodes, tGroups, tSlots);
          tObjs[j] = norm[j].value; tKeys[j] = key;
        }
      }
      // 回收未复用的旧节点
      for (var d = keys.length - 1; d >= 0; d--) if (!used[d]) teardownAt(d);
      // 按新顺序重排 DOM（已存在的节点 insertBefore 会移动到锚点前）
      for (var m = 0; m < newLen; m++) parent.insertBefore(tNodes[m], anchor);
      nodes = tNodes; groups = tGroups; slots = tSlots; objs = tObjs; keys = tKeys;
    }

    // renderList 的「收集」阶段：在依赖收集期（Dep.target 存在）读取源列表并 normalize，
    // 这样数组的元素下标 / length / 遍历（ITERATE_KEY）都会被订阅到当前渲染 watcher，
    // 原地修改（items[0]=x、push 等）才能正确触发重渲染。
    function renderList() {
      var newNorm = normalizeList(getValue(vm, info.value, scope));
      norm = newNorm;
      if (keyExp) renderByKey(computeKeys());
      else renderByIndex(newNorm);
    }
    // watcher 的 getter 主动读取并 normalize（收集元素级依赖），返回对象保证 run() 恒重渲染；
    // 首次进入即由构造时的 get() 完成依赖收集 + 渲染
    new Watcher(vm, function () {
      return normalizeList(getValue(vm, info.value, scope));
    }, renderList);

    // 首次渲染（依赖已在构造 get() 阶段收集完成）
    renderList();
  }

  function normalizeList(val) {
    var out = [];
    if (val == null) return out;
    if (Array.isArray(val)) {
      val.forEach(function (v, i) { out.push({ value: v, index: i, key: i }); });
    } else if (typeof val === 'object') {
      Object.keys(val).forEach(function (k, i) { out.push({ value: val[k], index: i, key: k }); });
    } else if (typeof val === 'number') {
      // 数字 v-for：取整兜底，负数/非整数不再产生异常行为
      var n = Math.max(0, Math.floor(val));
      for (var i = 0; i < n; i++) out.push({ value: i, index: i, key: i });
    }
    return out;
  }

  /* ==================== 6. 生命周期 ==================== */
  function callHook(vm, hook) {
    var fn = vm._options[hook];
    if (typeof fn === 'function') fn.call(vm);
  }

  /* ==================== 7. Vue 构造函数 ==================== */
  function Vue(options) {
    if (!(this instanceof Vue)) { console.error('Vue 需要 new 调用'); return; }
    this._options = options || {};
    this.$el = this._options.el;
    this._init();
  }

  Vue.prototype._init = function () {
    var vm = this;
    var opts = vm._options;

    // 本框架以 created 承担 Vue 传统的 beforeCreate（组件化之外的简化取舍）：此处即"创建前"，
    // 尚未挂载 DOM。完整生命周期链为 created/beforeMount/mounted/...，见 $mount / $destroy。
    vm.$data = typeof opts.data === 'function' ? opts.data() : (opts.data || {});
    vm._uid = ++uidCounter;
    // 必须用 observe 返回的代理接管 $data，这样后续所有读操作才会收集依赖
    vm.$data = observe(vm.$data);
    vm.$computed = {};
    vm._watchers = [];
    vm._boundNodes = [];
    vm.$refs = {};

    // 代理 data 到实例，方便 this.xxx 访问
    proxyData(vm, vm.$data);

    vm.$methods = opts.methods || {};
    bindMethods(vm);

    initComputed(vm, opts.computed);

    initWatch(vm, opts.watch);

    callHook(vm, 'created');

    if (vm.$el) vm.$mount(vm.$el);
  };

  function proxyData(vm, data) {
    Object.keys(data).forEach(function (key) { proxyToVm(vm, key); });
  }

  function bindMethods(vm) {
    Object.keys(vm.$methods).forEach(function (key) { vm[key] = vm.$methods[key].bind(vm); });
  }

  function initComputed(vm, computed) {
    if (!computed) return;
    Object.keys(computed).forEach(function (key) {
      var def = computed[key];
      var getter = typeof def === 'function' ? def : def.get;
      var setter = typeof def === 'object' ? def.set : null;

      // 惰性 watcher：只有 dirty 时才会重新求值，且求值时自己订阅依赖的数据
      var watcher = new Watcher(vm, function () { return getter.call(vm); }, noop, { lazy: true });

      Object.defineProperty(vm.$computed, key, {
        enumerable: true, configurable: true,
        get: function () {
          // 需要时重新求值（数据变化会触发惰性 watcher.update 把 dirty 置回 true）
          if (watcher.dirty) watcher.evaluate();
          // 让当前活跃的 watcher（如渲染 watcher）也依赖到它的数据源，
          // 数据一变，该 watcher 会被直接通知并重新渲染
          if (Dep.target) watcher.depend();
          return watcher.value;
        },
        set: function (v) { if (setter) setter.call(vm, v); }
      });

      // 将计算属性代理到实例，方便 this.xxx 访问（与 data 一致）
      Object.defineProperty(vm, key, {
        enumerable: true, configurable: true,
        get: function () { return vm.$computed[key]; },
        set: function (v) { vm.$computed[key] = v; }
      });
    });
  }

  // ---- watch：浅层 / 深度监听 ----
  // 复用 Watcher 的依赖收集 + 批量调度，与渲染/computed 同一套机制。
  // 支持字符串路径（'a.b'）或函数 getter；选项 immediate（初始化立即回调）、
  // sync（同步触发，不走队列）、deep（深度监听：递归收集嵌套依赖，对象/数组任意深变更都会触发）。
  Vue.prototype.$watch = function (expOrFn, cb, options) {
    var vm = this;
    options = options || {};
    var getter = typeof expOrFn === 'function' ? expOrFn : parsePath(expOrFn);
    if (typeof cb === 'string') cb = vm[cb];
    var watcher = new Watcher(vm, getter, function (val, old) { if (typeof cb === 'function') cb.call(vm, val, old); }, { sync: !!options.sync, deep: !!options.deep });
    if (options.immediate && typeof cb === 'function') cb.call(vm, watcher.value);
    return function unwatch() { watcher.teardown(); };
  };

  function initWatch(vm, watch) {
    if (!watch) return;
    Object.keys(watch).forEach(function (key) {
      var raw = watch[key];
      // 支持：函数 / 字符串方法名 / { handler, immediate, sync }
      var cfg = (raw && typeof raw === 'object') ? raw : {};
      var cb = typeof raw === 'function' ? raw : (typeof raw === 'string' ? vm[raw] : raw.handler);
      if (typeof cb === 'string') cb = vm[cb];
      if (typeof cb !== 'function') return;
      vm.$watch(key, cb, cfg);
    });
  }

  Vue.prototype.$mount = function (el) {
    var vm = this;
    var root = typeof el === 'string' ? document.querySelector(el) : el;
    if (!root) { warn('找不到元素: ' + el, vm); return; }
    vm.$rootEl = root;

    // 重新编译模板
    callHook(vm, 'beforeMount');
    compileTree(root, vm, null);

    callHook(vm, 'mounted');
  };

  // 销毁：解除实例下所有 watcher 的依赖订阅，并触发 beforeDestroy / destroyed 钩子。
  // 说明：不自动删除挂载的 DOM，交由调用方决定；只负责断开响应式订阅与引用，帮助 GC。
  Vue.prototype.$destroy = function () {
    var vm = this;
    if (vm._isDestroyed) return;
    callHook(vm, 'beforeDestroy');
    vm._isDestroyed = true;
    var w = vm._watchers || [];
    for (var i = w.length - 1; i >= 0; i--) {
      if (w[i].active) w[i].teardown();
    }
    vm._watchers = [];
    // 解绑所有已登记的事件监听，切断闭包对实例与元素的引用
    unbindAllListeners(vm);
    vm.$data = null;
    vm.$computed = null;
    vm.$methods = null;
    callHook(vm, 'destroyed');
  };

  // A5：把 data 的 key 代理到实例（初始化共用）
  function proxyToVm(vm, key) {
    Object.defineProperty(vm, key, {
      enumerable: true, configurable: true,
      get: function () { return vm.$data ? vm.$data[key] : undefined; },
      set: function (v) { if (vm.$data) vm.$data[key] = v; }
    });
  }

  /* ==================== A1：$nextTick ==================== */
  var nextTickCbs = [];
  var nextTickPending = false;
  Vue.prototype.$nextTick = Vue.prototype.nextTick = function (cb, ctx) {
    ctx = ctx || this;
    nextTickCbs.push(function () { if (cb) cb.call(ctx); });
    if (!nextTickPending) {
      nextTickPending = true;
      var flushCbs = function () {
        nextTickPending = false;
        var cbs = nextTickCbs.slice();
        nextTickCbs.length = 0;
        for (var i = 0; i < cbs.length; i++) cbs[i]();
      };
      if (typeof Promise !== 'undefined') Promise.resolve().then(flushCbs);
      else setTimeout(flushCbs, 0);
    }
  };

  /* ==================== 全局错误处理 ==================== */
  // 可全局接管：Vue.config.errorHandler / warnHandler 设置后，替换默认 console 输出，便于演示"错误边界"
  function handleError(vm, err, info) {
    var cfg = Vue.config || {};
    // 异常隔离：用户自定义 errorHandler 自身抛错时不再向上冒泡中断调度，回落到默认输出
    if (typeof cfg.errorHandler === 'function') {
      try { cfg.errorHandler.call(vm, err, vm, info); }
      catch (e) { console.error('[MataVue] errorHandler 自身出错: ' + (info || ''), e); }
      return;
    }
    console.error('[MataVue] ' + (info || ''), err);
  }
  function warn(msg, vm) {
    var cfg = Vue.config || {};
    if (typeof cfg.warnHandler === 'function') { cfg.warnHandler.call(vm, msg, vm); return; }
    console.warn('[MataVue]', msg);
  }

  // ============ 全局静态 API ============
  Vue.version = '1.0.0';
  Vue.nextTick = Vue.prototype.nextTick;
  // Vue.config：全局配置（errorHandler / warnHandler 接管提示与报错；performance 开启更新耗时计时；
  // html 默认 false —— 需渲染可信 HTML 时才显式置 true，见 htmlAllowed()）
  Vue.config = { html: false };

  global.Vue = Vue;
  if (typeof module !== 'undefined' && module.exports) module.exports = Vue;
})(typeof window !== 'undefined' ? window : this);