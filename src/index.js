import { DurableObject } from 'cloudflare:workers';
import { createApi } from './api.js';

/** 单个 SQLite Durable Object 管理本站数据：避免多人同时抽奖时库存竞态。 */
export class WulinPlatform extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.api = createApi(ctx.storage, env);
    this.queue = Promise.resolve();
  }
  async fetch(request) {
    // 原有业务流程在内存数组上修改，必须逐个处理 API 请求。
    const next = this.queue.then(() => this.api.handle(request));
    this.queue = next.catch(error => { console.error('Platform API error:', error); });
    return next;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) {
      const id = env.PLATFORM.idFromName('wulin-platform-main-v1');
      try { return await env.PLATFORM.get(id).fetch(request); }
      catch (error) { console.error('Storage error:', error); return new Response(JSON.stringify({error:'服务暂时不可用，请稍后再试'}),{status:503,headers:{'Content-Type':'application/json; charset=utf-8'}}); }
    }
    // 静态资源会自动将 /admin 映射到 public/admin.html；不要手动改写到 .html，避免 307 循环跳转。
    return env.ASSETS.fetch(request);
  },
};
