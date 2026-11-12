# 生成 Excel 技能
# 约定：def main(params) -> str，结果回填给模型。
# 依赖 openpyxl（已装进 python-runtime）。
import json
import os

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter


HEADER_FILL = PatternFill("solid", fgColor="0A84FF")   # 苹果蓝表头
ZEBRA_FILL = PatternFill("solid", fgColor="F2F6FB")    # 斑马纹浅蓝灰
thin = Side(style="thin", color="D9E2EC")
BORDER = Border(left=thin, right=thin, top=thin, bottom=thin)


def main(params):
    title = (params.get("title") or "Sheet1").strip()
    headers_raw = params.get("headers") or "[]"
    rows_raw = params.get("rows") or "[]"
    filename = (params.get("filename") or "").strip() or (title + ".xlsx")

    try:
        headers = json.loads(headers_raw)
        rows = json.loads(rows_raw)
    except Exception as e:
        return "错误：headers/rows 不是合法 JSON：" + str(e)

    if not isinstance(headers, list) or not isinstance(rows, list):
        return "错误：headers 和 rows 都必须是数组"

    if not filename.lower().endswith(".xlsx"):
        filename += ".xlsx"

    ws_dir = os.environ.get("AGENT_WORKSPACE") or os.path.expanduser("~")
    out = os.path.join(ws_dir, filename)

    wb = Workbook()
    ws = wb.active
    ws.title = title[:31]

    # ---- 表头 ----
    ws.row_dimensions[1].height = 24
    for c, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=c, value=str(h))
        cell.font = Font(bold=True, color="FFFFFF", size=11)
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = BORDER

    # ---- 数据行：斑马纹 + 数字右对齐 ----
    for r, row in enumerate(rows, 2):
        is_zebra = (r % 2 == 0)
        for c, v in enumerate(row, 1):
            cell = ws.cell(row=r, column=c, value=v)
            cell.border = BORDER
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                cell.alignment = Alignment(horizontal="right", vertical="center")
                cell.number_format = "#,##0.00" if isinstance(v, float) else "#,##0"
            else:
                cell.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)
            if is_zebra:
                cell.fill = ZEBRA_FILL

    # ---- 列宽自适应（按内容长度，含中文按 2 个宽度算） ----
    def disp_len(s):
        if s is None:
            return 0
        n = 0
        for ch in str(s):
            n += 2 if ord(ch) > 127 else 1
        return n

    for c in range(1, len(headers) + 1):
        letter = get_column_letter(c)
        maxlen = disp_len(headers[c - 1]) if c - 1 < len(headers) else 0
        for row in rows:
            if c - 1 < len(row):
                maxlen = max(maxlen, disp_len(row[c - 1]))
        ws.column_dimensions[letter].width = min(max(maxlen + 4, 10), 48)

    ws.freeze_panes = "A2"
    wb.save(out)
    return "已生成 Excel：%s（%d 列 × %d 行）" % (out, len(headers), len(rows))
