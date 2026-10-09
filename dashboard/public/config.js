// 运行时配置（部署后由静态托管直接提供，无需改动）。
// 看板数据通过 CloudBase Web SDK 匿名登录 + 云函数 callFunction 获取，无需手动填写接口地址。
//
// 本地预览演示数据：改成 true 即可强制走内置 mock（无需联网/口令）。
window.__TP_USE_MOCK__ = false;
