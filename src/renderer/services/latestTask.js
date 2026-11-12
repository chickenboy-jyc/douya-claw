/**
 * latestTask.js —— 「单飞 + 最新优先」的执行器。
 *
 * 【为什么需要它：一句可复现的现场描述】
 *   视频精剪的抽帧预览是「播放头动一下就抽一帧」。播放 = 播放头每秒推 4 次
 *   （`TICK_MS = 250`），每次都会调一次 `concatPreviewFrame`。而主进程那边
 *   **所有** Concat 调用共用一条串行队列（`concatStudio.enqueue`）——
 *   抽帧和「导入素材」「改片段」「导出」排的是同一个队。
 *
 *   于是只要抽一帧比 250ms 慢（真跑 720px 一帧常见 100~600ms），
 *   帧请求就会越积越多：队列里永远躺着 N 个抽帧，用户点「导入素材」
 *   要排在它们后面 ⇒ 表现就是**特别卡**；积压到超时（120s）就报错 ⇒
 *   **经常出错**。这不是"视频引擎慢"，是**上游没做限流**：
 *   一秒钟的播放能产生 4 个请求，而引擎一秒只能做完 2 个。
 *
 * 【语义（三条，缺一条就退化）】
 *   ① **并发恒 ≤ 1**：同一时刻只允许一个 `worker` 在跑；
 *   ② **最新优先**：忙的时候再来的请求**覆盖**待跑的那一个（中间的丢掉），
 *      不排队。用户要的是"现在这一帧"，不是"三秒前的四帧依次放一遍"；
 *   ③ **最后一个一定跑**：忙完发现有待跑的就立刻起一次。
 *      少了这条会出现"松手后画面停在拖动前那帧"——最容易被当成"预览坏了"。
 *
 * 【为什么不做"节流/防抖"就完事】
 *   防抖只解决"手抖连发"，解决不了「请求比间隔慢」：间隔 250ms、单次 600ms 时，
 *   防抖仍然每 250ms 放行一次 ⇒ 队列照样净增长。必须靠"忙时合并"。
 *
 * 【为什么单独一个文件】
 *   这段逻辑要能被单测直接断言（`scripts/smoke/unit-latest-task.mjs` 用假时钟跑），
 *   塞在组件的 `useEffect` 里就只能靠手点 —— 而"手点看起来不卡了"正是这个 bug
 *   最容易假绿的地方（一帧很快时，不加限流也不卡）。
 *
 * @template T
 * @param {(args:T)=>Promise<void>|void} worker 真正干活的函数；抛错由调用方自己处理
 * @returns {{run:(args:T)=>void, stats:()=>({busy:boolean, queued:boolean, coalesced:number, runs:number}), idle:()=>Promise<void>}}
 */
export function createLatestTask(worker) {
  if (typeof worker !== 'function') throw new TypeError('createLatestTask 需要一个函数');

  /** 是否已有一次在跑。 */
  let busy = false;
  /** 待跑的那一次（只留最新的一个）。`null` = 没有待跑。 */
  let pending = null;
  /** 被覆盖掉的请求数（读数用：0 表示从来没合并过，也就说明压力不大）。 */
  let coalesced = 0;
  /** 真正跑过的次数（读数用）。 */
  let runs = 0;
  /** 想让 `idle()` 能等到队排空。 */
  let settle = null;

  const drain = () => {
    if (busy) return;
    if (pending === null) {
      if (settle) { const done = settle; settle = null; done(); }
      return;
    }
    const args = pending;
    pending = null;
    busy = true;
    runs += 1;
    // `Promise.resolve(...).then` 而不是直接 await：worker 同步返回也要让出一次
    // 微任务，否则同步 worker 会在同一个 tick 里把 while 循环跑成真·同步递归。
    Promise.resolve()
      .then(() => worker(args))
      .catch(() => { /* worker 的错由它自己报；这里只保证队列不被一次异常掐断 */ })
      .then(() => {
        busy = false;
        drain();
      });
  };

  return {
    /** 提一个请求。忙的时候覆盖待跑那一个（最新优先）。 */
    run(args) {
      if (pending !== null) coalesced += 1;
      pending = args;
      drain();
    },
    /** 读数：给单测和「为什么又卡了」这类排查用。 */
    stats() {
      return { busy, queued: pending !== null, coalesced, runs };
    },
    /** 等到当前与待跑的都被消化完（测试用；生产代码不需要）。 */
    idle() {
      if (!busy && pending === null) return Promise.resolve();
      return new Promise((res) => { settle = res; });
    },
  };
}
