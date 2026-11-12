# 分析数据技能：pandas 读 CSV/Excel，返回概览 + 描述统计
import os

import pandas as pd


def main(params):
    p = (params.get("path") or "").strip()
    if not p:
        return "错误：请提供文件路径"
    try:
        head_n = int(float(params.get("head") or 5))
    except Exception:
        head_n = 5

    ws = os.environ.get("AGENT_WORKSPACE") or os.path.expanduser("~")
    full = p if os.path.isabs(p) else os.path.join(ws, p)
    if not os.path.exists(full):
        return "错误：文件不存在：" + full

    ext = os.path.splitext(full)[1].lower()
    try:
        if ext == ".csv":
            df = pd.read_csv(full)
        elif ext in (".xlsx", ".xls"):
            df = pd.read_excel(full)
        else:
            return "错误：只支持 .csv / .xlsx / .xls"

        lines = []
        lines.append("形状：%d 行 × %d 列" % df.shape)
        lines.append("列名：%s" % ", ".join(str(c) for c in df.columns))
        lines.append("类型：\n" + df.dtypes.to_string())

        num_cols = df.select_dtypes(include="number").columns.tolist()
        if num_cols:
            lines.append("\n数值列描述统计：\n" + df[num_cols].describe().to_string())

        lines.append("\n前 %d 行：\n%s" % (head_n, df.head(head_n).to_string()))
        return "\n".join(lines)
    except Exception as e:
        return "分析失败：" + str(e)
