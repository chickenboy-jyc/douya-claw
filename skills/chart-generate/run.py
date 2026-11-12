# 生成图表技能：柱状图/折线图/饼图
import json
import os

import matplotlib
matplotlib.use("Agg")  # 无界面后端
import matplotlib.pyplot as plt

plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "Arial"]
plt.rcParams["axes.unicode_minus"] = False


def main(params):
    ctype = (params.get("chart_type") or "").strip().lower()
    labels_raw = params.get("labels") or "[]"
    values_raw = params.get("values") or "[]"
    title = (params.get("title") or "").strip()
    xlabel = (params.get("xlabel") or "").strip()
    ylabel = (params.get("ylabel") or "").strip()
    output = (params.get("output") or "").strip() or "chart.png"

    try:
        labels = json.loads(labels_raw)
        values = json.loads(values_raw)
    except Exception as e:
        return "错误：labels/values 不是合法 JSON：" + str(e)

    if not isinstance(labels, list) or not isinstance(values, list):
        return "错误：labels 和 values 都必须是数组"
    if len(labels) != len(values) or len(labels) == 0:
        return "错误：labels 和 values 长度必须一致且非空"

    if ctype not in ("bar", "line", "pie"):
        return "错误：chart_type 只支持 bar/line/pie"

    try:
        values_num = [float(v) for v in values]
    except Exception:
        return "错误：values 必须是数值"

    fig, ax = plt.subplots(figsize=(9, 5.5), dpi=120)

    if ctype == "bar":
        ax.bar(labels, values_num, color="#0a84ff")
        if xlabel:
            ax.set_xlabel(xlabel)
        if ylabel:
            ax.set_ylabel(ylabel)
    elif ctype == "line":
        ax.plot(labels, values_num, marker="o", color="#0a84ff", linewidth=2)
        if xlabel:
            ax.set_xlabel(xlabel)
        if ylabel:
            ax.set_ylabel(ylabel)
        ax.grid(True, linestyle="--", alpha=0.4)
    else:  # pie
        ax.pie(values_num, labels=labels, autopct="%1.1f%%", startangle=90,
               colors=["#0a84ff", "#30d158", "#ff9f0a", "#ff375f", "#bf5af2", "#5ac8fa"])

    if title:
        ax.set_title(title, fontsize=15, fontweight="bold")

    ws = os.environ.get("AGENT_WORKSPACE") or os.path.expanduser("~")
    if not output.lower().endswith((".png", ".jpg", ".jpeg", ".svg", ".pdf")):
        output += ".png"
    out = output if os.path.isabs(output) else os.path.join(ws, output)

    fig.tight_layout()
    fig.savefig(out)
    plt.close(fig)
    return "已生成图表（%s）：%s" % (ctype, out)
