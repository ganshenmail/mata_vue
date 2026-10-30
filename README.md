# ✨ MataVue

纯原生 JS 实现的轻量级Vue ——无需 npm / 无需构建，`<script>` 引用即可运行。

一个「教学用 · 可读 · 无依赖」的迷你前端框架演示项目，核心源码仅约 1000 行。

## 特性

* **响应式系统**：基于数据劫持实现依赖收集与自动更新
* **模板指令**：文本插值 `{{ }}`、`v-model`、`v-text`、`v-html`
* **计算属性** `computed`：依赖自动追踪、缓存更新
* **条件渲染** `v-if / v-else-if / v-else`、`v-show`
* **列表渲染** `v-for`：支持数组、`(item, index)` 形式
* **属性/样式绑定** `:`、`:class`、`:style`
* **事件绑定** `@click` 与修饰符：`.prevent` `.stop` `.once` `.self` 及鼠标键 `.left / .right / .middle`
* **指令修饰符**：`v-model.trim` `v-model.lazy` `v-model.number`、`@keydown.enter`
* **`v-cloak`**：防止未编译时的插值闪现
* **生命周期**：`created` / `mounted`
* **`$nextTick`**：批量更新后回调

## 文件结构

```
mata_vue/
├── index.html   # 功能演示页面
├── vue.js       # 源码（约 1000 行，含注释）
├── vue.min.js   # 压缩版（页面实际引用）
└── README.md
```

## 运行方式

无需安装任何依赖，直接用浏览器打开 `index.html` 即可：

```
start index.html
```

或启动一个本地静态服务器（可选）：

```
npx serve .
```

## 使用示例

```html
<div id="app">
  <p>你好，{{ greeting }}！</p>
  <input v-model="greeting" />
  <button @click="count++">+1</button>
  <p>计数：{{ count }}</p>
</div>

<script src="./vue.min.js"></script>
<script>
  new Vue({
    el: '#app',
    data() {
      return { greeting: '访客', count: 0 };
    }
  });
</script>
```

## 说明

* 全功能演示与交互见 `index.html`，右键打开控制台可查看生命周期日志与事件输出。
* `vue.js` 为带注释的可读源码，适合学习响应式、虚拟节点更新与指令编译的原理。
* 注意 `v-html` 存在 XSS 风险，生产环境请谨慎使用；`v-cloak` 不要放在根元素 `#app` 自身。
* v-for性能不如vue。
* 没有watch监听，没有组件，没有使用 虚拟DOM，也没有代理Proxy。
