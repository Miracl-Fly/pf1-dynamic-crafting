import { CraftingApp } from "./crafting-app.js";

Hooks.once("init", () => {
  console.log("PF1 Dynamic Crafting | 初始化");
});

// 在场景控制按钮（左侧工具栏）注册一个“铁砧”图标
Hooks.on("getSceneControlButtons", (controls) => {
  // 兼容 v13 的对象结构和早期版本的数组结构
  const tokenControls = controls.tokens || controls.find?.(c => c.name === "token");
  if (!tokenControls || !tokenControls.tools) return;

  const toolConfig = {
    name: "pf1-dynamic-crafting",
    title: "动态造物工坊",
    icon: "fas fa-hammer",
    button: true,
    onClick: () => new CraftingApp().render(true),
  };

  if (Array.isArray(tokenControls.tools)) {
    tokenControls.tools.push(toolConfig);
  } else {
    tokenControls.tools["pf1-dynamic-crafting"] = toolConfig;
  }
});