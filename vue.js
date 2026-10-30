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
  // 当前列表渲染分组：v-for 重建子树期间新建的 watcher 会登记进来，便于下次重建前统一回收
  var currentWatcherGroup = null;
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
    this.dirty = this.lazy || this.lazyInit;
    this.active = true;
    this.getter = typeof getter === 'function' ? getter : parsePath(getter);
    this.value = (this.lazy || this.lazyInit) ? undefined : this.get();
    // 若处于 v-for 重建分组中，则并入分组，供下次重建前统一 teardown
    if (currentWatcherGroup) currentWatcherGroup.push(this);
  }
  Watcher.prototype.get = function () {
    pushTarget(this);
    var value = this.getter.call(this.vm, this.vm);
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
    for (queueIndex = 0; queueIndex < queue.length; queueIndex++) {
      var watcher = queue[queueIndex];
      scheduledHas[watcher.id] = null;
      try { watcher.run(); }
      catch (e) { handleError(watcher.vm, e, '渲染/监听 watcher 执行'); }
    }
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

  /* ==================== 4. 表达式取值/赋值 ==================== */
  function getValue(vm, exp, scope) {
    exp = String(exp == null ? '' : exp).trim();
    if (exp === '') return '';
    var first = exp.split('.')[0];
    // 简单路径
    if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(exp)) {
      if (scope && first in scope) return read(scope, exp);
      if (first in vm.$data) return read(vm.$data, exp);
      if (first in vm.$computed) return read(vm.$computed, exp);
      return read(vm, exp);
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
      if (cur[seg[i]] === undefined || cur[seg[i]] === null) { if (cur[seg[i]] === undefined) cur[seg[i]] = {}; }
      else if (typeof cur[seg[i]] !== 'object') { cur[seg[i]] = {}; }
      cur = cur[seg[i]];
    }
    if (cur != null) cur[seg[seg.length - 1]] = val;
  }

  function read(obj, path) {
    var cur = obj;
    var seg = path.split('.');
    for (var i = 0; i < seg.length; i++) { if (cur == null) return undefined; cur = cur[seg[i]]; }
    return cur;
  }

  // 表达式编译结果缓存：key 带参数名列表，保证不同 vm/scope 上下文互不串用
  var expCache = {};
  function evalExp(vm, exp, scope) {
    var scopeKeys = [], dataKeys = [], compKeys = [];
    if (scope) scopeKeys = Object.keys(scope).filter(isId);
    dataKeys = Object.keys(vm.$data).filter(isId);
    compKeys = Object.keys(vm.$computed).filter(isId);
    var all = dedupe(scopeKeys.concat(dataKeys).concat(compKeys));
    var args = all.map(function (k) {
      if (scope && k in scope) return scope[k];
      if (k in vm.$data) return vm.$data[k];
      return vm.$computed[k];
    });
    var cacheKey = exp + '\u0000' + all.join(',');
    var fn = expCache[cacheKey];
    if (!fn) {
      try { fn = expCache[cacheKey] = new Function(all.join(','), 'return (' + exp + ');'); }
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
      textParseCache[text] = tokens;
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

  function watchEffect(vm, fn) { new Watcher(vm, fn, fn); fn(); }
  function bindText(node, vm, exp, scope, html) {
    watchEffect(vm, function upd() {
      if (html) node.innerHTML = stringify(getValue(vm, exp, scope));
      else node.textContent = stringify(getValue(vm, exp, scope));
    });
  }

  function compileElement(node, vm, scope) {
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
    for (var j = 0; j < attrs.length; j++) {
      var attr = attrs[j];
      var name = attr.name;
      var value = attr.value.trim();

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
    var attrs2 = Array.prototype.slice.call(node.attributes);
    for (var k = 0; k < attrs2.length; k++) {
      if (dirRE.test(attrs2[k].name)) node.removeAttribute(attrs2[k].name);
    }

    // v-show
    if (dirShow !== '') {
      watchEffect(vm, function updShow() { node.style.display = getValue(vm, dirShow, scope) ? '' : 'none'; });
    }

    // 递归子节点
    walk(node, vm, scope);
  }

  /* ---- v-on / 事件 ---- */
  function bindEvent(node, vm, eventSpec, handlerExp) {
    // 解析事件名与修饰符：@click.stop.prevent、@keydown.enter ...
    var parts = eventSpec.split('.');
    var eventName = parts[0];
    var mods = parts.slice(1);
    var hasOnce = mods.indexOf('once') > -1;
    var hasPrevent = mods.indexOf('prevent') > -1;
    var hasStop = mods.indexOf('stop') > -1;
    var hasSelf = mods.indexOf('self') > -1;
    var btnMods = ['left', 'right', 'middle'].filter(function (m) { return mods.indexOf(m) > -1; });
    // 鼠标键修饰：click 事件的 e.button 在部分浏览器（如 Firefox）恒为 0，无法区分左/中/右键；
    // 带 .left/.right/.middle 且原事件是 click 时，改监听 mousedown（e.button 跨浏览器可靠）来精准判定。
    var bindEventName = (btnMods.length > 0 && eventName === 'click') ? 'mousedown' : eventName;

    function rawHandler(e) {
      if (typeof vm[handlerExp] === 'function') { vm[handlerExp](e); return; }
      try {
        // with(vm) 把 data / computed / methods 都暴露到求值作用域，
        // 通过 vm 代理的 getter/setter 保证 count++ 这类写操作能正确回写数据
        var exp = 'with(vm){ return (' + handlerCompile(handlerExp) + '); }';
        var fn = new Function('vm', '$event', exp);
        fn(vm, e);
      } catch (err) { handleError(vm, err, '事件处理出错: ' + handlerExp); }
    }

    var wrapper = function (e) {
      // .self：仅当事件目标就是当前元素时才触发
      if (hasSelf && e.target !== node) return;
      // .left / .right / .middle：按鼠标键过滤
      if (btnMods.length && !isBtnMatched(e, btnMods)) return;
      if (hasPrevent && e.preventDefault) e.preventDefault();
      if (hasStop && e.stopPropagation) e.stopPropagation();
      // 键盘修饰符（.enter / .esc / .tab / .up ... 或具体键码数字）
      if (mods.length && e.type.indexOf('key') === 0 && !isKeyMatched(e, mods)) return;
      rawHandler(e);
      if (hasOnce) node.removeEventListener(bindEventName, wrapper);
    };
    node.addEventListener(bindEventName, wrapper);
  }

  function isBtnMatched(e, mods) {
    // button: 0=左键 1=中键 2=右键
    var map = { left: 0, middle: 1, right: 2 };
    return mods.some(function (m) { return e.button === map[m]; });
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

  /* ---- v-bind ---- */
  function bindAttr(node, vm, attrName, exp, scope) {
    // 记录静态 class / style，后续与动态值合并而非整块覆盖
    var statClass = '', statStyle = '';
    if (attrName === 'class') statClass = node.getAttribute && node.getAttribute('class') || '';
    else if (attrName === 'style') statStyle = (node.getAttribute && node.getAttribute('style') || '').replace(/;\s*$/, '');

    function apply() {
      var val = getValue(vm, exp, scope);
      if (attrName === 'style') {
        var dynS = stringify(toStyle(val));
        node.style.cssText = (statStyle ? statStyle + ';' : '') + dynS;
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
  function toStyle(val) {
    if (typeof val === 'string') return val;
    var css = [];
    if (Array.isArray(val)) {
      val.forEach(function (it) {
        if (it && typeof it === 'object') joinStyle(css, it);
        else if (typeof it === 'string') css.push(it);
      });
    } else if (val && typeof val === 'object') {
      joinStyle(css, val);
    } else if (val == null) {
      return '';
    }
    return css.join('');
  }
  function joinStyle(css, obj) {
    Object.keys(obj).forEach(function (k) {
      css.push(camelToDash(k) + ':' + obj[k] + ';');
    });
  }
  function camelToDash(s) {
    return s.replace(/([A-Z])/g, function (m) { return '-' + m.toLowerCase(); });
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
      node.addEventListener('change', function () {
        var cur = getValue(vm, path, scope);
        if (Array.isArray(cur)) {
          var idx = cur.indexOf(node.value);
          if (node.checked && idx === -1) setValue(vm, path, cur.concat(node.value), scope);
          else if (!node.checked && idx > -1) { cur.splice(idx, 1); setValue(vm, path, cur.slice(), scope); }
        } else {
          setValue(vm, path, node.checked ? (trueVal !== null ? trueVal : true) : (falseVal !== null ? falseVal : false), scope);
        }
      });
    } else if (node.type === 'radio') {
      node.addEventListener('change', function () {
        if (node.checked) setValue(vm, path, node.value, scope);
      });
    } else {
      // .lazy 改为 change 触发，否则用 input（默认）
      var listenEvent = mods.indexOf('lazy') > -1 ? 'change' : 'input';
      node.addEventListener(listenEvent, function () { setValue(vm, path, toVal(node.value), scope); });
      if (listenEvent === 'input') {
        node.addEventListener('change', function () { setValue(vm, path, toVal(node.value), scope); });
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
    new Watcher(vm, update, update);
    update();
  }
  function bindModelSelect(node, vm, path, scope) {
    node.addEventListener('change', function () { setValue(vm, path, node.value, scope); });
    function update() {
      var v = getValue(vm, path, scope);
      node.value = v === null || v === undefined ? '' : String(v);
    }
    new Watcher(vm, update, update);
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
    });

    var rendered = null;

    function render() {
      // 从第一个分支开始，命中第一个条件为真的分支（v-else 无条件命中）
      var chosen = null;
      for (var i = 0; i < branches.length; i++) {
        var b = branches[i];
        if (b.cond === '' || !!getValue(vm, b.cond, scope)) { chosen = b; break; }
      }
      if (rendered) { rendered.remove(); rendered = null; }
      if (chosen) {
        rendered = chosen.tpl.cloneNode(true);
        parent.insertBefore(rendered, chosen.anchor.nextSibling);
        compileTree(rendered, vm, scope);
      }
    }

    // 让 watcher 订阅所有分支条件，任一变化即重新选择并渲染
    new Watcher(vm, function () {
      var hit = false;
      for (var i = 0; i < branches.length; i++) {
        if (branches[i].cond !== '' && !!getValue(vm, branches[i].cond, scope)) hit = true;
      }
      return hit;
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

    // 固定锚点：v-for 产出都插在它前面，标记渲染位置且避免每次重建锚点
    var anchor = document.createComment(' v-for-end ');
    parent.insertBefore(anchor, node);
    parent.removeChild(node);

    var norm = [];    // 当前归一化列表（渲染期间共享，供各作用域 getter 即时读取）
    var nodes = [];   // 每个索引对应的 DOM 节点
    var groups = [];  // 每个节点编译产生的 watcher 分组，用于复用/回收
    var slots = [];   // 每个节点的可编辑位置槽 { i }
    var objs = [];    // 每个节点上一次渲染绑定的 item 对象（用于判断是否需重跑 watcher）

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
    function addNode(pos, slot) {
      var clone = origin.cloneNode(true);
      var childScope = makeScope(slot);
      var g2 = [];
      parent.insertBefore(clone, anchor);
      currentWatcherGroup = g2;
      try {
        compileTree(clone, vm, childScope);
      } finally {
        restoreGroup();
      }
      nodes[pos] = clone;
      groups[pos] = g2;
      slots[pos] = slot;
    }

    function runGroup(k) {
      var gl = groups[k];
      for (var w = 0; w < gl.length; w++) gl[w].run();
    }

    function restoreGroup() {
      currentWatcherGroup = null;
    }

    function teardownAt(k) {
      var g = groups[k];
      for (var t = 0; t < g.length; t++) g[t].teardown();
      parent.removeChild(nodes[k]);
    }

    // ---- 索引模式：按位置复用，行为与优化前一致 ----
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

    // renderList 的「收集」阶段：在依赖收集期（Dep.target 存在）读取源列表并 normalize，
    // 这样数组的元素下标 / length / 遍历（ITERATE_KEY）都会被订阅到当前渲染 watcher，
    // 原地修改（items[0]=x、push 等）才能正确触发重渲染。
    function renderList() {
      var newNorm = normalizeList(getValue(vm, info.value, scope));
      renderByIndex(newNorm);
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
      for (var i = 0; i < val; i++) out.push({ value: i, index: i, key: i });
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

    vm.$data = typeof opts.data === 'function' ? opts.data() : (opts.data || {});
    // 必须用 observe 返回的代理接管 $data，这样后续所有读操作才会收集依赖
    vm.$data = observe(vm.$data);
    vm.$computed = {};

    // 代理 data 到实例，方便 this.xxx 访问
    proxyData(vm, vm.$data);

    vm.$methods = opts.methods || {};
    bindMethods(vm);

    initComputed(vm, opts.computed);

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

  Vue.prototype.$mount = function (el) {
    var vm = this;
    var root = typeof el === 'string' ? document.querySelector(el) : el;
    if (!root) { warn('找不到元素: ' + el, vm); return; }
    vm.$rootEl = root;

    // 重新编译模板
    compileTree(root, vm, null);

    callHook(vm, 'mounted');
  };

  // A5：把 data 的 key 代理到实例（初始化共用）
  function proxyToVm(vm, key) {
    Object.defineProperty(vm, key, {
      enumerable: true, configurable: true,
      get: function () { return vm.$data[key]; },
      set: function (v) { vm.$data[key] = v; }
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
  function handleError(vm, err, info) {
    console.error('[MataVue] ' + (info || ''), err);
  }
  function warn(msg, vm) {
    console.warn('[MataVue]', msg);
  }

  global.Vue = Vue;
  if (typeof module !== 'undefined' && module.exports) module.exports = Vue;
})(typeof window !== 'undefined' ? window : this);