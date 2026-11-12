# 抠图去背景技能：把主体从背景里分离出来，输出**带透明通道的 PNG**
#
# ────────────────────────────────────────────────────────────────────────────
# 为什么需要这个技能（用户报障，2026-02）
# ────────────────────────────────────────────────────────────────────────────
#   用户原话：「agent 功能……根本不能闭环 而且连个桌宠都不会做，怎么做一些更高级的开发……
#              他连怎么做，怎么去实现优化都不会。」
#   现场：让他做一只桌面宠物，助手答"做完了"，交付的却是一个**网页**；抠图那一步只抠出了
#         **半身**（上半身有内容、下半身全透明），而且它自己不知道。
#   ⇒ 之前 `skills/image-edit` 只有 resize/crop/rotate/grayscale/convert/watermark/brightness
#     七个动作，**没有任何去背景能力**。助手于是只能"假装抠了"。
#     本技能补的就是这一步。它同时也补上"抠完自己量一遍"的闭环 ——
#     光能抠、不能自检，等于把"我抠好了"这句话继续交给模型猜。
#
# ────────────────────────────────────────────────────────────────────────────
# 为什么是**纯 numpy**（不是 numpy+scipy —— 这条踩过，别再改回去）
# ────────────────────────────────────────────────────────────────────────────
#   本技能的 manifest 是 `allowNetwork: false`（它真的不联网：没有模型、没有下载）。
#   而 `src/main/skills.js` 的 python bootstrap 在 `allowNetwork !== true` 时会给
#   `builtins.__import__` 套一个网络模块拦截器（socket/urllib/http/requests/...）。
#   实测（2026-02，解释器 = 打包 runtime）：
#     · `import numpy`            → OK
#     · `import PIL.Image`        → OK
#     · `import scipy`            → OK（顶层能过）
#     · `import scipy.ndimage`    → **ImportError: network disabled for this skill: urllib.parse**
#   原因：scipy 的 `_lib/_docscrape.py` 会 `import pydoc`，而 pydoc 顶层 `import urllib.parse`。
#   拦截器按**顶层包名**判（`'urllib.parse'.split('.')[0] == 'urllib'`），拦得比意图宽。
#   ⇒ 在真机上走 `runSkill()` 时，任何 scipy 子模块都**必然**被拦死。
#   ⚠️ 这个坑只有"真跑一次 agent 路径"能看见：直接用 python 跑 `main()` 全绿，走 skills.js
#      才炸。所以 `scripts/smoke/unit-cutout.mjs` 的 [8] 专门跑一次 runSkill()，
#      把这条钉死 —— 别再删掉那一段，它抓的就是这种"本地绿、线上红"。
#   现在用到的能力全都是自己用 numpy 实现的（都不难，且没有隐藏的 import 链）：
#     · 4-连通连通域 → 行游程 + 并查集（见 `_edge_connected`），宽高上万也不慢；
#     · 腐蚀/膨胀   → 四邻移位叠加（`_erode` / `_dilate`），羽化上限 8 次，代价可忽略；
#     · 高斯近似    → 可分离 [1,2,1]/4 连续模糊（`_soften_u8`，uint16 就地累加 ——
#                      float64 版本在大图上会多吃 870MB，见该函数注释）。
#
# ────────────────────────────────────────────────────────────────────────────
# 三种 mode（不允许一个算法通吃 —— 硬套一种的结果就是"抠出半身还报成功"）
# ────────────────────────────────────────────────────────────────────────────
#   · flood（默认，纯色/近纯色背景）：从四条边缘向内做**连通域泛洪**，只把「与画布边缘
#     连通、且颜色与边缘主色差在容差内」的像素判为背景。
#     🔴 关键：**绝不用"整图按颜色阈值删"**。按颜色全删会把主体内部同色的部分
#        （白大褂、白牙、白眼球）一起吃掉，或者反过来在主体中间开洞 ——
#        这正是"抠出半身/抠出残缺主体"的一种成因。连通性是这条判据的半条命，
#        另一半是"起点必须贴边"。`unit-cutout.mjs` 里有一条反控专治这件事：
#        把连通性去掉（只按颜色删）⇒ `cutout-bgcolor-in-subject.png` 那条当场转红。
#   · alpha（原图已有透明通道）：把已有 alpha 二值化后羽化。用于"已经是 PNG 但边缘脏"。
#   · box（兜底，主体大致居中且背景简单）：按行列方向的背景色投影找主体包围盒，裁掉外部
#     纯背景。这条**不产生透明区**，所以它一定会在下面的"前景占比"判据里被点出来 ——
#     这是刻意的：留下一条"交付不透明图还能报成功"的路，等于把这个 bug 留着。
#
# ────────────────────────────────────────────────────────────────────────────
# 诚实红线（本技能存在的**全部**理由）
# ────────────────────────────────────────────────────────────────────────────
#   写盘之后**重新打开产物**量一遍（不是量内存里的数组 —— 量的必须是用户拿到的那份文件），
#   口径与 `skills/image-info/run.py` 完全一致：
#     · 尺寸 / 透明通道有无 / alpha 包围盒（alpha>0 的像素的最小外接矩形 x0,y0,x1,y1）
#     · 主体占画布宽高百分比 / 是否贴边（四边各一个布尔）
#     · 前景像素占比（alpha>0 的像素 / 总像素）
#   然后照读数给结论（判据写死在下面常量里，改口径 = 改产品行为）：
#     · 前景 < 3%   ⇒ **失败**（几乎什么都没抠出来；容差太小或背景不是纯色）
#     · 前景 > 97%  ⇒ **失败**（背景几乎没被去掉；容差太大或这个 mode 不产生透明区）
#     · 贴住 ≥2 条边 ⇒ 警告（主体被画布边缘裁切）
#     · 包围盒高度 < 画布 50% 且贴住上边 ⇒ 警告「只抠出了半身」（用户遇到的形态）
#   失败时返回值**以「抠图失败：」开头**（`src/main/skills.js` 的 `FAILURE_HEAD_RE` 只认
#   开头前缀，写在中间等于没写）；先给结论再给读数，**绝不**先写一段漂亮话把失败藏在后面。
import math
import os

import numpy as np
from PIL import Image

# ===========================================================================
# 固定文案 / 阈值 —— 门禁 scripts/smoke/unit-cutout.mjs 按这些句子与常量判读。
# 改文案要同步改门禁；改阈值 = 改产品行为（见文件头「诚实红线」）。
# ===========================================================================
FAIL_HEAD = "抠图失败："
WARN_HEAD = "警告："

HINT_HALFBODY = "主体集中在上半部，注意是否只抠出了半身（下半部几乎全透明）。"
HINT_EDGE_TOUCH = "主体贴到画布边缘，可能被裁切。"
HINT_BOX = "用的是兜底模式（box），效果可能不精确 —— 它只按行列投影把画布裁到主体范围，不生成透明区。"

MODE_AUTO = "auto"
MODE_FLOOD = "flood"
MODE_ALPHA = "alpha"
MODE_BOX = "box"
VALID_MODES = (MODE_AUTO, MODE_FLOOD, MODE_ALPHA, MODE_BOX)

DEFAULT_TOL = 30          # 颜色容差：RGB 三通道的最大差值（切比雪夫距离），0~255
DEFAULT_FEATHER = 1       # 边缘羽化像素（0 = 不羽化）
MAX_FEATHER = 8
EDGE_TOLERANCE = 1        # 贴边判定容差（像素，与 skills/image-info 同口径）
FG_FAIL_MIN = 0.03        # 前景占比下限：低于它 ⇒ 几乎什么都没抠出来
FG_FAIL_MAX = 0.97        # 前景占比上限：高于它 ⇒ 背景几乎没被去掉
HALFBODY_COVER_H = 0.5    # 包围盒高度 < 画布 50% …
BORDER_UNIFORM_MIN = 0.6  # 边缘环里与本环主色接近的像素占比 ≥ 60% ⇒ 判为纯色背景（auto 用）
ALPHA_REAL_MAX = 250      # 存在 alpha < 250 的像素 ⇒ 认为原图**真的**有透明区
ALPHA_KEEP_LEVEL = 8      # alpha 模式二值化阈值
OPAQUE_LEVEL = 250        # 「完全不透明」读数阈值

# ───────────────────────────────────────────────────────────────────────────
# 超大图降采样阈值 —— 数字是**量出来的**；而且量完之后结论被改过一次，两次都记下来
# ───────────────────────────────────────────────────────────────────────────
#   ⚠️ 这一段的依据变过，别再只引前一半 —— 前一半的结论后来被实测推翻了。
#
#   【第一次量：为什么"撞 timeout"这个前提不成立】
#   本仓 Win 开发机实测（**当时的实现**：羽化走 float64）：
#      6 MP (3000×2000)  1.08s /  2.56s（f1/f8）
#     12 MP (4000×3000)  1.59s /  4.84s
#     24 MP (4000×6000)  3.57s / 10.32s
#     36 MP (6000×6000)  5.69s / 14.51s   峰值 2134 MB
#     48 MP (8000×6000)  6.62s / 20.64s   峰值 2833 MB
#   ⇒ 时间只占 timeoutMs(120s) 的 8.6%(24MP) / 17%(48MP)。
#     "手机原图 24MP 会撞 120 秒"这个前提**不成立**；按超时定阈值，阈值会落在
#     200MP 以上、这条分支永远不触发 = 做了一件永不见效的事。
#
#   【第二次量：内存才是瓶颈，但**不是降采样能解决的**】
#   逐段量峰值 RSS（5100×5000）后发现：真正的凶手是羽化里的 `astype(np.float64)`
#   全尺寸中间数组（`_soften_axis` 的 vstack/hstack 各开一份整数组）——
#   单步 **+870 MB**，比"降不降采样"的差别大一个量级。
#   把羽化改成 uint16 就地累加（见 `_soften_u8`）之后，同一批图重测：
#     25.5 MP (5100×5000)  真身 817 MB / **变异体（摘掉阈值）817 MB**
#     48    MP (8000×6000)  真身 1504 MB / **变异体 1504 MB**
#     ⇒ **内存差 0**。降采样把 mask 计算搬到了小图上，但全尺寸 I/O
#       （PIL 解码 4B/px、out_arr 4B/px、PNG 编码、重新打开自检）才是大头，一分没省。
#   降采样真正省的是**时间**（f8：25.5MP 4.45→3.30s，48MP 7.88→6.62s，约 −16~26%）。
#   ⇒ 所以这个常量现在的定位是 **"大图的时间与过渡带权衡"**，不是内存保护。
#     内存保护来自 `_soften_u8`（2833→1504 MB，−47%），而且它对**所有尺寸**生效，
#     包括按设计不降采样的 24MP 常态图 —— 那才是"等半天没反应"的主因。
#
#   【为什么仍取 24.0 MP】
#     ① 24MP 恰好是 4000×6000（手机原图常态）⇒ 常态永不降采样、永不掉精度；
#     ② 从 24MP 往上，f8 羽化的耗时开始翻倍（10.3s@24MP → 14.5s@36MP），
#        而且羽化带宽越大、小图上做羽化的画质偏差越明显，再往上收益/代价不划算；
#     ③ 判据是 `>`（严格大于）⇒ 正好 24,000,000 像素**不**降采样（①要成立必须严格大于）。
#
#   ⚠️ 已知残余风险（不在本常量职责内，别指望它兜）：**极大图（>100MP）仍会 OOM**。
#      因为全尺寸 I/O 不可省，降采样救不了；那种尺寸只能靠下面的 `MemoryError`
#      分支返回「内存不够…建议先缩小图片」—— 至少它不会假装成功。
MAX_PIXELS = 24000000
# ☠️ 文案禁区（eng-see-own 2026-02 踩过的坑）：**不许在对外文案里写「非全透明」**。
#    中文里它有两个读法 ——「非 / 全透明」（= alpha>0，我想要的意思）和「非全 / 透明」
#    （≈ 不透明），正好相反。对方技能就是因为这个词，把「透明 93.8%」印成了
#    「非全透明像素约 93.8%」，照字面读会得出"这图 93.8% 不透明"这个相反结论。
#    ⇒ 本文件对外只报两个数、每个都带**可核对的判据**，不靠形容词：
#        「前景像素占比：X%（alpha>0 共 N / 总 M）」
#        「其中完全不透明：Y%（alpha>=250 共 K）」
#      「完全不透明」是 Y 的专有名字，「前景」是 X 的专有名字，两者都有显式判据兜着，
#      交换或反转都读得出来。注释里为了行文省事可以用简写，对外文案一律不准。


# ===========================================================================
# 小工具
# ===========================================================================
def _to_int(value, default, low, high):
    """把 params 里的值转成 [low, high] 内的整数；坏值一律退回 default。"""
    try:
        v = int(float(value))
    except Exception:
        return default
    if v < low:
        return low
    if v > high:
        return high
    return v


def _pct(v):
    """比例 → 一位小数的百分比字符串。"""
    return "%.1f%%" % (float(v) * 100.0)


def _mp(pixels):
    """像素数 → 「X.X MP」字符串（1 MP = 1e6 像素）。"""
    return "%.1f MP" % (float(pixels) / 1e6)


def _yes_no(flag):
    return "是" if flag else "否"


def _cheb(pixels, color):
    """RGB 切比雪夫距离（三通道最大绝对差）。pixels 可为 (H,W,3) 或 (N,3)，返回少一维的数组。"""
    diff = np.abs(pixels.astype(np.int16) - np.asarray(color, dtype=np.int16))
    return diff.max(axis=-1)


def _border_ring(rgb):
    """取画布最外一圈像素（上/下各整行 + 左/右各整列；四角会重复，只影响统计权重不影响中位数）。"""
    h, w = rgb.shape[0], rgb.shape[1]
    return np.concatenate(
        (rgb[0, :, :], rgb[h - 1, :, :], rgb[:, 0, :], rgb[:, w - 1, :]),
        axis=0,
    )


def _border_stats(rgb, tol):
    """边缘环主色 + 「环里有多少像素接近这个主色」。

    返回值 `coverage` 就是 auto 判「纯色背景」的依据。
    为什么要用**中位数**而不是均值：主体压住一两条边时（贴边素材），
    均值会被主体色拖走，中位数不会。
    """
    ring = _border_ring(rgb)
    bg_color = np.median(ring, axis=0)
    ring_dist = _cheb(ring, bg_color)
    coverage = float(np.count_nonzero(ring_dist <= tol)) / float(max(1, ring.shape[0]))
    return bg_color, coverage, int(ring.shape[0])


# ===========================================================================
# 4-连通连通域：**只保留与画布边缘连通的那一块**当背景（纯 numpy 行游程 + 并查集）
# ===========================================================================
def _row_runs(row):
    """一行布尔数组里所有连续 True 段的 [起, 止]（含端点）。"""
    padded = np.zeros(row.shape[0] + 2, dtype=np.int8)
    padded[1:-1] = row.astype(np.int8)
    delta = np.diff(padded)
    starts = np.flatnonzero(delta == 1)
    ends = np.flatnonzero(delta == -1) - 1
    return starts, ends


def _edge_connected(candidate, w, h):
    """把布尔图里「与画布边缘连通」的像素挑出来（**4-连通**）。

    为什么必须 4-连通（不是 8-连通）：8-连通允许**对角穿过**，主体边缘的锯齿会把
    背景从斜角"漏"进主体内部，或者把主体和背景斜着连成一片 ⇒ 主体被吃掉一条缝。
    4-连通宁可少判一点背景，也不会把主体穿洞。

    为什么要连通域而不是"按颜色全删"：见文件头「三种 mode」里的 🔴 那条。

    实现 = 行游程（run）+ 并查集（union-find）：
      ① 每行把候选像素压成若干条游程 —— 一整个纯色背景通常每行只有 1~2 条，
         所以游程总数远小于像素数，Python 层的并查集代价可忽略；
      ② 相邻两行里 x 区间有交集的游程并起来（两指针扫，均摊 O(游程数)）；
      ③ 游程触碰画布任一边 ⇒ 它所在集合是"背景"；
      ④ 把所有"背景集合"里的游程还原成像素掩码。
    复杂度 ≈ O(像素数 + 游程数·α)，3000×2000 实测也只要几十毫秒。

    Args:
        candidate: (H,W) 布尔数组，True 表示"颜色像背景"。
        w: 画布宽。h: 画布高。

    Returns:
        (H,W) 布尔数组，True 表示"判为背景"。
    """
    fg_h, fg_w = int(candidate.shape[0]), int(candidate.shape[1])
    if fg_h != h or fg_w != w:
        h, w = fg_h, fg_w
    bg = np.zeros((h, w), dtype=bool)
    if h == 0 or w == 0:
        return bg

    parent = []   # 并查集：游程 id → 父 id
    run_row = []  # 每条游程所在行
    run_left = []
    run_right = []
    touches_edge = []  # 该游程是否直接触碰画布边缘
    rows = []     # 每行的游程 id 列表

    def find(a):
        root = a
        while parent[root] != root:
            root = parent[root]
        while parent[a] != root:  # 路径压缩
            parent[a], a = root, parent[a]
        return root

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for y in range(h):
        starts, ends = _row_runs(candidate[y])
        ids = []
        for s, e in zip(starts, ends):
            rid = len(parent)
            parent.append(rid)
            run_row.append(y)
            run_left.append(int(s))
            run_right.append(int(e))
            touches_edge.append((int(s) == 0) or (int(e) == w - 1) or y == 0 or y == h - 1)
            ids.append(rid)
        rows.append(ids)

    # 相邻行：x 区间有交集就并（4-连通）
    for y in range(1, h):
        prev, cur = rows[y - 1], rows[y]
        i = j = 0
        while i < len(prev) and j < len(cur):
            a, b = prev[i], cur[j]
            if run_right[a] < run_left[b]:
                i += 1
            elif run_right[b] < run_left[a]:
                j += 1
            else:  # 有交集
                union(a, b)
                if run_right[a] < run_right[b]:
                    i += 1
                elif run_right[b] < run_right[a]:
                    j += 1
                else:
                    i += 1
                    j += 1

    # 收集"背景根"（任一成员触边 ⇒ 整个集合判背景）
    bg_roots = set()
    for rid in range(len(parent)):
        if touches_edge[rid]:
            bg_roots.add(find(rid))
    if not bg_roots:
        return bg  # 没有任何候选像素触边 ⇒ 没有背景（主体顶到了四条边之外的情况）
    for rid in range(len(parent)):
        if find(rid) in bg_roots:
            bg[run_row[rid], run_left[rid]:run_right[rid] + 1] = True
    return bg


def _flood_mask(rgb, tol):
    """flood 模式的前景掩码。返回 (fg_mask, bg_color, coverage)。"""
    h, w = int(rgb.shape[0]), int(rgb.shape[1])
    bg_color, coverage, _ring_len = _border_stats(rgb, tol)
    candidate = _cheb(rgb, bg_color) <= tol
    # 🔴 RC 锚点（门禁的反控按这一行做变异）：背景 = 与画布边缘连通的候选像素。
    #    把这行换成 `bg = candidate`（只按颜色不按连通）⇒ 主体内部同色区域会被一起删掉，
    #    `scripts/smoke/unit-cutout.mjs` 的 cutout-bgcolor-in-subject 断言当场转红。
    bg = _edge_connected(candidate, w, h)
    return ~bg, bg_color, coverage


def _alpha_mask(src_alpha):
    """alpha 模式的前景掩码：已有 alpha 二值化（阈值 8，避开 PNG 保存后的极低残值）。"""
    return src_alpha > ALPHA_KEEP_LEVEL


def _projection_bbox(rgb, bg_color, tol):
    """box 模式的包围盒：整行/整列都像背景就裁掉，返回 (x0, y0, x1, y1)。

    只在「背景简单到每一行/每一列都能被单一颜色判定」时有意义，
    所以它在 manifest 里是兜底、在返回文本里带着 HINT_BOX 的免责说明。
    """
    h, w = int(rgb.shape[0]), int(rgb.shape[1])
    bgpix = _cheb(rgb, bg_color) <= tol
    rows = np.flatnonzero(~bgpix.all(axis=1))
    cols = np.flatnonzero(~bgpix.all(axis=0))
    if rows.size == 0 or cols.size == 0:
        return 0, 0, w, h  # 整幅都像背景 ⇒ 不裁（后面的判据会说清"几乎什么都没抠出来"）
    return int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1


# ===========================================================================
# 形态学 / 模糊（纯 numpy；不用 scipy —— 理由见文件头）
# ===========================================================================
def _dilate4(mask):
    """4-邻膨胀一次（越界的邻域不参与，不会在边界"凭空长出来"）。"""
    out = mask.copy()
    out[1:, :] |= mask[:-1, :]
    out[:-1, :] |= mask[1:, :]
    out[:, 1:] |= mask[:, :-1]
    out[:, :-1] |= mask[:, 1:]
    return out


def _erode4(mask):
    """4-邻腐蚀一次 = 对补集膨胀后取反（这样越界行为与膨胀严格对偶）。"""
    return ~_dilate4(~mask)


def _dilate(mask, iterations):
    out = mask
    for _ in range(max(0, int(iterations))):
        out = _dilate4(out)
    return out


def _erode(mask, iterations):
    out = mask
    for _ in range(max(0, int(iterations))):
        out = _erode4(out)
    return out


def _soften_u8(arr_u8, rounds):
    """对 8 位数组做可分离 [1,2,1]/4 模糊（近似高斯，rounds 次 ⇒ σ ≈ sqrt(rounds/2)），
    但走 **uint16 就地累加**，不是 float64。

    为什么不是 float64 —— 这是分段实测出来的，不是理论推的：
      5100×5000（25.5MP）上，`_soften(astype(np.float64), 1)` 一步峰值 **+870 MB**
      （float64 是 8 字节/像素，vstack/hstack 又各开一份整数组）。
      它比整个降采样省下来的还多 ⇒ 结果就是「降采样了，但内存一分没省」。
      分段实测（峰值 RSS MB）：
        ①PIL 取图 232 → ②视图 427 → ⑤小图上抠 676 → **⑦全尺寸 float64 软化 1546** ← 凶手
      改 uint16 后同一步只 +~150MB（字节数 1/4，且就地累加不额外开整数组）。
    取值上界：255×2 + 255 + 255 = 1020 < 65535，不会溢出。
    边界夹紧（首/末行复制自己）⇒ 画布边缘不会被"凭空压暗"，与图像处理惯例一致。
    """
    cur = arr_u8.astype(np.uint16)
    for _ in range(max(0, int(rounds))):
        acc = cur * 2
        acc[1:] += cur[:-1]
        acc[:-1] += cur[1:]
        acc //= 4
        nxt = acc * 2
        nxt[:, 1:] += acc[:, :-1]
        nxt[:, :-1] += acc[:, 1:]
        nxt //= 4
        cur = nxt
    return cur.astype(np.uint8)


# ===========================================================================
# 边缘羽化
# ===========================================================================
def _feather_alpha(fg, feather_px):
    """把硬边掩码羽化成 8 位 alpha：**羽化不许吃掉主体**。

    做法 = 软化 + 两头夹死：
      · `core`（向内腐蚀 feather 像素）⇒ 强行 255（主体内部绝不半透明，否则桌宠会"发灰"）；
      · `far`（向外膨胀 feather 像素之外）⇒ 强行 0（背景干净）；
      · 中间那一圈才是过渡带。
    只做模糊不夹死的话，低 alpha 会一路渗到主体内部，看上去像"整只宠物蒙了层雾"。

    ⚠️ 2026-02 改过实现：原来 `soft = _soften(fg.astype(np.float64), feather_px)`，
       float64 在 24MP 上光这一步就要 ~700MB 峰值（`_soften_axis` 的 vstack/hstack 各开一份整数组）。
       现在走 `_soften_u8`（uint16 就地累加），同一步内存降到 ~1/4，8 位输出上看不出差别。
       这是"大图会卡死"那条报障的直接成因之一 —— 不是算法慢，是中间数组太大。
    """
    if feather_px <= 0:
        return (fg.astype(np.uint8) * np.uint8(255))
    it = max(1, int(round(feather_px)))
    soft = _soften_u8(fg.astype(np.uint8) * np.uint8(255), it)
    core = _erode(fg, it)
    far = ~_dilate(fg, it)
    soft[core] = 255
    soft[far] = 0
    return soft


# ===========================================================================
# 超大图降采样（plan / 读数行）—— 依据见文件头 MAX_PIXELS 那段实测
# ===========================================================================
def _cut_alpha(rgb, src_alpha, chosen, tol, feather_px):
    """按 mode 算出**该分辨率下**的 8 位 alpha。

    抽出来是为了让"全尺寸"和"降采样"两条路走同一段逻辑 —— 否则降采样那条很容易
    悄悄少一个步骤（比如漏掉 flood 的"保留原图已有透明区"），而门禁在小图上全绿。
    """
    if chosen == MODE_FLOOD:
        fg = _flood_mask(rgb, tol)[0]
    else:
        fg = _alpha_mask(src_alpha)
    return _feather_alpha(fg, feather_px)


def _shrink_plan(w, h, chosen, feather):
    """要不要降采样、降几倍。返回 None（不降）或 dict。

    **只有 flood / alpha 会降采样，box 不降**：box 是裁剪，输出尺寸本来就 ≠ 原图，
    降采样之后包围盒映射不回原尺寸；而且它的行列投影本来就不碰全图，没有内存压力。
    ⇒「输出尺寸必须等于原图」是**模式相关**的约束，不是通例 —— 写在这里免得后人当通例用。
    """
    if chosen not in (MODE_FLOOD, MODE_ALPHA):
        return None
    total_px = int(w) * int(h)
    if total_px <= MAX_PIXELS:
        return None
    # 整数倍缩放：分数倍会让内部尺寸出现小数像素，也会让 feather 的换算失真。
    scale = max(2, int(math.ceil(math.sqrt(float(total_px) / float(MAX_PIXELS)))))
    return {
        "scale": scale,
        "sw": max(1, -(-int(w) // scale)),   # 向上取整：宁可多算一个像素也不丢边
        "sh": max(1, -(-int(h) // scale)),
        # 羽化带宽按比例换到小图上做 ⇒ 放大回原尺寸后物理带宽正好还是 feather 像素。
        "feather_ds": (max(1, int(round(feather * scale))) if feather > 0 else 0),
        "total_px": total_px,
    }


def _shrink_line(plan):
    """降采样读数行 —— **不许静默降采样**：原图像素数、降几倍、内部按多大处理，全写出来。

    门禁 `[13]` 解析这一行的内部尺寸 `sw × sh`，**独立**算一遍 `ceil(w/scale)` 对账，
    再用一条峰值内存对比（真身低 / 变异体高）证明它真的处理了小图，而不是只改了文案 ——
    只断言"文案里有这句话"正是我 `[11]` 那次假绿的形态（断内容、不断事实）。
    """
    return (
        "降采样：原图 %s（%d 像素）超过上限 %s，已按 %d 倍降采样抠图"
        "（内部按 %d × %d = %s 处理），边缘精度会略降"
        % (
            _mp(plan["total_px"]), plan["total_px"],
            _mp(MAX_PIXELS),
            plan["scale"],
            plan["sw"], plan["sh"], _mp(int(plan["sw"]) * int(plan["sh"])),
        )
    )


# ===========================================================================
# 几何读数（口径与 skills/image-info/run.py 一致）
# ===========================================================================
def _geometry(alpha_u8, w, h):
    """读一份 alpha 通道的全部客观读数。返回 (dict, lines)。

    `bbox` 用 PIL 的 `getbbox()`（alpha>0 的像素的最小外接矩形），
    与 `skills/image-info/run.py` 同一口径 —— 两个技能对同一张图必须报同一组数，
    否则模型会看到两个"都对"的答案。
    """
    total = int(w) * int(h)
    alpha_im = Image.fromarray(alpha_u8, mode="L")
    bbox = alpha_im.getbbox()
    nonzero = int(np.count_nonzero(alpha_u8))            # alpha > 0（含半透明边缘）
    opaque = int(np.count_nonzero(alpha_u8 >= OPAQUE_LEVEL))
    fg_ratio = (float(nonzero) / float(total)) if total > 0 else 0.0
    opaque_ratio = (float(opaque) / float(total)) if total > 0 else 0.0

    info = {
        "total": total,
        "nonzero": nonzero,
        "opaque": opaque,
        "fg_ratio": fg_ratio,
        "opaque_ratio": opaque_ratio,
        "has_transparency": nonzero < total,
        "bbox": bbox,
        "cover_w": 0.0,
        "cover_h": 0.0,
        "touch": {"left": False, "right": False, "top": False, "bottom": False},
    }

    lines = []
    lines.append("透明通道：" + ("有" if info["has_transparency"] else "无（整幅全不透明）"))

    if bbox is None:
        lines.append("alpha 包围盒：无（整幅全透明：alpha>0 的像素数为 0）")
    else:
        x0, y0, x1, y1 = bbox
        lines.append("alpha 包围盒：%d,%d,%d,%d（x0,y0,x1,y1）" % (x0, y0, x1, y1))
        info["cover_w"] = (float(x1 - x0) / float(w)) if w else 0.0
        info["cover_h"] = (float(y1 - y0) / float(h)) if h else 0.0
        info["touch"] = {
            "left": x0 <= EDGE_TOLERANCE,
            "right": x1 >= (w - EDGE_TOLERANCE),
            "top": y0 <= EDGE_TOLERANCE,
            "bottom": y1 >= (h - EDGE_TOLERANCE),
        }

    lines.append(
        "主体占画布：宽 %s / 高 %s（按 alpha 包围盒计）"
        % (_pct(info["cover_w"]), _pct(info["cover_h"]))
    )
    lines.append(
        "主体贴边：left=%s right=%s top=%s bottom=%s"
        % (
            _yes_no(info["touch"]["left"]),
            _yes_no(info["touch"]["right"]),
            _yes_no(info["touch"]["top"]),
            _yes_no(info["touch"]["bottom"]),
        )
    )
    lines.append("前景像素占比：%s（alpha>0 共 %d / 总 %d）" % (_pct(fg_ratio), nonzero, total))
    lines.append("其中完全不透明：%s（alpha>=%d 共 %d）" % (_pct(opaque_ratio), OPAQUE_LEVEL, opaque))
    return info, lines


def _verdict(info):
    """照读数给结论。返回 (fails, warns)，各是字符串列表。

    fails 里的每一条都会让返回值以「抠图失败：」开头 —— 不许把失败降级成提示。
    """
    fails = []
    warns = []

    if info["fg_ratio"] < FG_FAIL_MIN:
        fails.append(
            "几乎什么都没抠出来（前景只剩 %s），背景容差可能太小，或背景不是纯色"
            % _pct(info["fg_ratio"])
        )
    if info["fg_ratio"] > FG_FAIL_MAX:
        fails.append(
            "背景几乎没被去掉（前景仍有 %s），容差可能太大或背景太杂"
            % _pct(info["fg_ratio"])
        )

    touch_count = sum(1 for v in info["touch"].values() if v)
    if touch_count >= 2:
        warns.append(HINT_EDGE_TOUCH)
    if info["bbox"] is not None and info["cover_h"] < HALFBODY_COVER_H and info["touch"]["top"]:
        warns.append(HINT_HALFBODY)
    return fails, warns


def _advice(mode, tol):
    """失败时的可执行建议（照 mode 给不同的下一步，不是一句"请重试"）。"""
    if mode == MODE_FLOOD:
        return (
            "建议：① 调小 tol（例如 %d~%d）再跑一次看前景是不是回来了；"
            "② 背景是渐变/花纹时 flood 判不准，可试 mode=box 只看包围盒；"
            "③ 背景实在复杂时本技能（纯 numpy，没有 AI 分割模型）抠不准 —— "
            "请换一张背景纯净的素材，**不要**把带底色的 PNG 当透明素材交付。"
            % (max(5, tol // 3), max(10, tol // 2))
        )
    if mode == MODE_ALPHA:
        return (
            "建议：① mode=alpha 只处理「原图已有透明通道」的情况；原图没有透明区时它会保留整幅，"
            "请改用 mode=flood（纯色背景）或 mode=auto；"
            "② 调大 tol（例如 %d）后再试 flood。"
            % min(255, tol * 2)
        )
    return (
        "建议：① box 模式只裁画布、**不生成透明区**，要透明素材请改用 mode=flood 并调 tol；"
        "② 调大 tol（例如 %d）再看；③ 背景复杂就换素材 —— 这个技能没有 AI 分割模型，"
        "认不出「哪一块是背景」，它只会照着边缘颜色连通地判。"
        % min(255, tol * 2)
    )


def _pick_mode(requested, has_real_alpha, bg_color, coverage, tol):
    """决定用哪个 mode，并给出**人话理由**（理由要进返回值，模型才能解释给用户）。"""
    if requested != MODE_AUTO:
        return requested, "按调用方指定 mode=" + requested

    if has_real_alpha:
        return MODE_ALPHA, "原图已经有真正的透明区（存在 alpha<250 的像素），直接沿用并羽化"
    if coverage >= BORDER_UNIFORM_MIN:
        return MODE_FLOOD, (
            "边缘环里 %s 的像素与边缘主色 rgb(%d,%d,%d) 接近（tol=%d），判为纯色背景"
            % (
                _pct(coverage),
                int(round(bg_color[0])),
                int(round(bg_color[1])),
                int(round(bg_color[2])),
                tol,
            )
        )
    return MODE_BOX, (
        "边缘颜色不统一（只有 %s 的像素与边缘主色接近，低于 %s 的纯色判定线），只能走兜底 box"
        % (_pct(coverage), _pct(BORDER_UNIFORM_MIN))
    )


# ===========================================================================
# 入口
# ===========================================================================
def main(params):
    """抠图去背景：读一张图 → 生成带透明通道的 PNG → 重新量一遍 → 照读数给结论。

    Args:
        params: dict，含 path（必填）、output、mode（auto/flood/alpha/box）、tol、feather。

    Returns:
        str: 给人看的文本。失败时**以「抠图失败：」开头**，并把读数与建议一并列出。
    """
    p = (params.get("path") or "").strip()
    if not p:
        return "错误：请提供图片路径"

    mode = (params.get("mode") or MODE_AUTO).strip().lower()
    if mode not in VALID_MODES:
        return "错误：不支持的 mode：" + mode + "（支持 auto/flood/alpha/box）"
    tol = _to_int(params.get("tol"), DEFAULT_TOL, 0, 255)
    feather = _to_int(params.get("feather"), DEFAULT_FEATHER, 0, MAX_FEATHER)

    ws = os.environ.get("AGENT_WORKSPACE") or os.path.expanduser("~")
    full = p if os.path.isabs(p) else os.path.join(ws, p)
    if not os.path.exists(full):
        return "错误：图片不存在：" + full

    try:
        with Image.open(full) as opened:
            opened.load()
            rgba = opened.convert("RGBA")
    except Exception as e:
        return FAIL_HEAD + "打不开这张图（" + str(e) + "）"

    arr = np.asarray(rgba)
    h, w = int(arr.shape[0]), int(arr.shape[1])
    if h == 0 or w == 0:
        return FAIL_HEAD + "图像尺寸为 0，没有可抠的内容"
    rgb = arr[:, :, :3]
    src_alpha = arr[:, :, 3]
    has_real_alpha = bool(np.any(src_alpha < ALPHA_REAL_MAX))

    bg_color, coverage, _ring_len = _border_stats(rgb, tol)
    chosen, why = _pick_mode(mode, has_real_alpha, bg_color, coverage, tol)
    plan = _shrink_plan(w, h, chosen, feather)

    # ── 按 mode 产出 RGBA 数组 ──
    #    降采样那条路（plan 不为 None）刻意写成"小图上抠、mask 放大回原尺寸再应用"：
    #    输出必须是原尺寸，否则用户拿到的是一张小图 —— 那是最坏的一种"成功"。
    try:
        if chosen in (MODE_FLOOD, MODE_ALPHA):
            if plan is not None:
                small = rgba.resize((plan["sw"], plan["sh"]), Image.BILINEAR)
                s_arr = np.asarray(small)
                a_small = _cut_alpha(s_arr[:, :, :3], s_arr[:, :, 3], chosen, tol, plan["feather_ds"])
                del s_arr, small
                # 放大用 BILINEAR **不是** NEAREST：阶梯状的成因是最近邻插值，
                # 双线性本身就是平滑滤波，这一步就把"阶梯"治在根上。
                a_big = np.asarray(Image.fromarray(a_small, mode="L").resize((w, h), Image.BILINEAR))
                del a_small
                if feather > 0:
                    # 再补一次廉价 1px 软化 = "在原尺寸上又走了一遍羽化"的最小形态。
                    # （不重跑 _feather_alpha：全尺寸重跑会把降采样的内存收益吃掉一半，
                    #   而它要解决的阶梯问题起因是插值方式，不是羽化缺位。）
                    # ⚠️ 必须用 _soften_u8（uint16），别图省事写成 astype(np.float64)：
                    #    实测在 25.5MP 上那一步会 +870MB，把降采样的收益全吃掉。
                    a_big = _soften_u8(a_big, 1)
                alpha_u8 = a_big
                del a_big
            else:
                alpha_u8 = _cut_alpha(rgb, src_alpha, chosen, tol, feather)
            if chosen == MODE_FLOOD:
                # 原图已有的透明区必须保留（否则在已经抠过的图上再抠一次会把"已删除"的地方补回来）
                alpha_u8 = np.minimum(alpha_u8, src_alpha)
            out_arr = np.dstack([rgb, alpha_u8]).astype(np.uint8)
            del alpha_u8
        else:  # MODE_BOX —— 不降采样（裁剪，输出尺寸本来就变）
            x0, y0, x1, y1 = _projection_bbox(rgb, bg_color, tol)
            out_arr = np.array(arr[y0:y1, x0:x1, :], dtype=np.uint8, copy=True)
    except MemoryError:
        return FAIL_HEAD + "内存不够（图太大：%d × %d）。建议先缩小图片再抠。" % (w, h)
    except Exception as e:
        return FAIL_HEAD + "处理失败（mode=%s）：%s" % (chosen, str(e))

    # ── 写盘（透明必须 PNG）──
    output = (params.get("output") or "").strip()
    if not output:
        base, _ext = os.path.splitext(full)
        output = base + "-cutout.png"
    if not os.path.splitext(output)[1]:
        output += ".png"
    out_full = output if os.path.isabs(output) else os.path.join(ws, output)
    try:
        parent = os.path.dirname(out_full)
        if parent and not os.path.isdir(parent):
            os.makedirs(parent, exist_ok=True)
        Image.fromarray(out_arr, mode="RGBA").save(out_full, format="PNG")
    except Exception as e:
        return FAIL_HEAD + "写不出输出文件：" + out_full + "（" + str(e) + "）"

    # ── 量**产物**（不是量内存里的数组：用户拿到的是这个文件）──
    try:
        with Image.open(out_full) as produced:
            produced.load()
            produced_rgba = produced.convert("RGBA")
            out_w, out_h = produced.size
            measured = np.asarray(produced_rgba)
            measured_alpha = measured[:, :, 3]
    except Exception as e:
        return FAIL_HEAD + "输出文件读不回来，无法自检：" + out_full + "（" + str(e) + "）"

    info, geo_lines = _geometry(measured_alpha, out_w, out_h)
    fails, warns = _verdict(info)
    if chosen == MODE_BOX:
        warns.append(HINT_BOX)

    # ── 拼返回文本：失败时**第一行就是结论**，绝不让漂亮话占住开头 ──
    head_lines = []
    if fails:
        head_lines.append(FAIL_HEAD + fails[0])
    elif warns:
        head_lines.append("抠图有警告（mode=%s）：读数里有需要你先看清的地方，别直接当成品交付。" % chosen)
    else:
        head_lines.append("抠图完成（mode=%s）：主体已从背景里分离，输出带透明通道的 PNG。" % chosen)

    lines = list(head_lines)
    lines.append("输出：" + out_full)
    lines.append("模式：%s（%s）" % (chosen, why))
    lines.append("尺寸：原图 %d × %d 像素 → 输出 %d × %d 像素" % (w, h, out_w, out_h))
    if plan is not None:
        # 紧跟「尺寸：」之后：那一行说"输出和原图一样大"，这一行解释"那为什么精度略降"。
        lines.append(_shrink_line(plan))
    lines.extend(geo_lines)
    lines.append("参数：tol=%d（颜色容差，切比雪夫距离）· feather=%d 像素（边缘羽化）" % (tol, feather))

    for extra in fails[1:]:
        lines.append(FAIL_HEAD + extra)
    for wmsg in warns:
        lines.append(WARN_HEAD + wmsg)

    if fails:
        lines.append(_advice(chosen, tol))
    else:
        lines.append(
            "下一步：把这张 PNG 当素材用之前，可以用「识别图片」技能再量一次核对读数，"
            "或用「读文件」看一眼成品；要交付给用户的是 **PNG**（JPG 不支持透明）。"
        )
    return "\n".join(lines)
