# ✨ MataVue

纯原生 JS 实现的轻量级 Vue——无需 npm / 无需构建，`<script>` 引用即可运行。

一个「可读 · 无依赖」的迷你前端框架演示项目，核心源码约 1300 行（含注释与安全开关）。

## 特性

* **响应式系统**：基于数据劫持（Proxy）实现依赖收集与批量更新
* **模板指令**：文本插值 `{{ }}`、`v-model`、`v-text`、`v-html`
* **计算属性** `computed`：依赖自动追踪、缓存更新
* **条件渲染** `v-if / v-else-if / v-else`、`v-show`（`v-show` 与 `:style` 可安全共存）
* **列表渲染** `v-for`：支持数组 `(item, index)`、对象 `(value, key, index)`、数字范围；`v-for` 作用域带 `$index`、`ref` 自动收集为节点数组
* **属性/样式绑定** `:`、`:class`（字符串/对象/数组）、`:style`（字符串/对象/数组，属性级增量合并）
* **事件绑定** `@click` 与修饰符：`.prevent` `.stop` `.once` `.self`、鼠标键 `.left/.right/.middle`、系统键 `.ctrl/.shift/.alt/.meta`（＋ `.exact` 要求恰好组合）、`.capture` `.passive`
* **指令修饰符**：`v-model.trim` `v-model.lazy` `v-model.number`、`@keydown.enter`（含 `.up/.down/.esc/.tab` 等别名与数字键码）
* **`v-cloak`**：防止未编译时的插值闪现；**`v-pre`**：跳过整个子树编译
* **生命周期**：`beforeCreate` 由 `created` 承担 —— 完整链为 `created / beforeMount / mounted / beforeUpdate / updated / beforeDestroy / destroyed`
* **`$nextTick` / `Vue.nextTick`**：批量更新后回调
* **实例 API**：`$watch`（浅层 / 深度）、`$refs`、`$destroy`、`Vue.toRaw`（取回未被代理的原始对象）、`Vue.version`、`Vue.config`
* **全局配置**：`Vue.config.errorHandler` / `warnHandler` 接管报错与提示，`performance` 输出更新耗时；`Vue.config.html === true` 显式开启 `v-html`（默认关闭，见下）
* **watch**：浅层 / 深度监听（`$watch` / `watch:{}`），支持 `immediate`、`sync`、`deep`，返回 unwatch 取消监听
* **资源安全**：事件监听统一登记，`$destroy` 与 `v-for` 回收时自动解绑，避免内存泄漏；表达式/文本/事件编译结果带容量上限的缓存（FIFO 淘汰）
* **性能**：批量调度（微任务 flush + 同 tick 去重）、简单路径解析/表达式作用域缓存、v-for 支持 `:key` 复用保状态

## 文件结构

```
mata_vue/
├── vue.js      # 源码（约 1300+ 行，含注释，页面直接引用）
└── README.md
```

## 使用示例

```html
<div id="app">
  <p>你好，{{ greeting }}！</p>
  <input v-model="greeting" />
  <button @click="count++">+1</button>
  <p>计数：{{ count }}</p>

  <!-- 需要渲染实体富文本时，显式开启后再使用 v-html（默认关闭） -->
  <!-- <p v-html="htmlContent"></p> -->
</div>

<script src="./vue.js"></script>
<script>
  // Vue.config.html = true; // 可选：确需 v-html 时在 new Vue 前开启
  new Vue({
    el: '#app',
    data() {
      return { greeting: '访客', count: 0, htmlContent: '<b>可信富文本</b>' };
    }
  });
</script>
```

## 说明

* 全功能演示与交互见 `index.html`，右键打开控制台可查看生命周期日志与事件输出。
* `vue.js` 为带注释的可读源码，适合学习响应式、指令编译与批量调度的原理。
* **安全**：`{{ }}` / `v-text` 走 `textContent` 写入，天然安全；`v-html` 默认关闭，未开启时降级为纯文本并告警一次，仅当设置 `Vue.config.html = true` 才写入原始 HTML——此时仍需在数据源侧清洗（去 `<script>`、`on*`、`javascript:` 等）。
* `v-for` 性能弱于 Vue（无虚拟 DOM）：未提供 `:key` 时按位置复用；提供 `:key` 时按 key 复用并保留节点内部状态（如输入框、事件），后退回位置复用。
* 注意 `v-cloak` 不要放在根元素 `#app` 自身。
* watch 支持浅层与深度监听：复用现有的 Watcher/调度器，支持 `immediate`（初始化立即回调）、`sync`（同步触发不走批处理）；`deep: true` 时在依赖收集阶段递归遍历值树，对象/数组任意深度的变更都会触发回调（深度遍历在一次异步 flush 内合并触发）。

## 已实现 / 明确不做

|  | 类别 | 状态 |
| --- | --- | --- |
|  | 响应式（Proxy） / 计算属性 / watch（浅层 + 深度 `deep`） | ✅ 已实现 |
|  | 指令：插值、v-model、v-if/v-else、v-show、v-for（数组/对象/数字）、v-text、v-html、v-cloak、v-pre | ✅ 已实现 |
|  | 绑定：`:class`、`:style`（属性级合并）、`:attr`；事件修饰符（防冒、停止、一次、自身、键码、鼠标键、系统键、capture/passive/exact、once） | ✅ 已实现 |
|  | 生命周期钩子（created/beforeMount/mounted/beforeUpdate/updated/beforeDestroy/destroyed） | ✅ 已实现 |
|  | 实例/全局 API：`$watch` `$refs` `$destroy` `$nextTick` `Vue.nextTick` `Vue.toRaw` `Vue.version` `Vue.config` | ✅ 已实现 |
|  | 全局配置：`errorHandler` / `warnHandler` / `performance` / `html`（v-html 开关） | ✅ 已实现 |
|  | 性能：批量调度（微任务 flush + tick 去重）、简单路径/表达式作用域缓存、v-for 按 `:key` 复用 | ✅ 已实现 |
|  | 资源安全：事件监听统一登记与 $destroy/v-for 自动解绑、表达式缓存容量上限 | ✅ 已实现 
