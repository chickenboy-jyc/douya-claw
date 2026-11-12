# 编辑 Excel 技能：打开现有 .xlsx 原地修改，保留原格式/公式/合并单元格/多工作表。
# 约定：def main(params) -> str，结果回填给模型。
# 依赖 openpyxl（已装进 python-runtime）。
import json
import os

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter


def resolve_cell(ws, cell):
    """把 cell 参数（"A1" 或 [row, col]）解析成 openpyxl 单元格对象。"""
    if isinstance(cell, (list, tuple)) and len(cell) >= 2:
        return ws.cell(row=int(cell[0]), column=int(cell[1]))
    if isinstance(cell, str):
        return ws[cell]
    raise ValueError('cell 参数须为 "A1" 或 [row, col]')


def get_sheet(wb, name):
    """按名取工作表，缺省返回活动工作表。"""
    if name:
        if name in wb.sheetnames:
            return wb[name]
        raise ValueError('找不到工作表：' + str(name))
    return wb.active


def main(params):
    path_raw = (params.get("path") or "").strip()
    operations_raw = params.get("operations") or "[]"
    output = (params.get("output") or "").strip()

    if not path_raw:
        return "编辑失败：缺少 path（原 xlsx 文件路径）"

    # 相对路径先尝试在工作区里找（与 doc-read 行为一致）
    if not os.path.isabs(path_raw) and not os.path.exists(path_raw):
        ws_dir = os.environ.get("AGENT_WORKSPACE")
        if ws_dir:
            candidate = os.path.join(ws_dir, path_raw)
            if os.path.exists(candidate):
                path_raw = candidate

    if not os.path.exists(path_raw):
        return "编辑失败：文件不存在：" + path_raw

    try:
        operations = json.loads(operations_raw)
    except Exception as e:
        return "编辑失败：operations 不是合法 JSON：" + str(e)
    if not isinstance(operations, list):
        return "编辑失败：operations 必须是数组"

    try:
        # 不带 data_only：保留公式（不读缓存值）
        wb = load_workbook(path_raw)
    except Exception as e:
        return "编辑失败：无法打开 xlsx（可能不是有效 Excel 文件）：" + str(e)

    changes = 0
    try:
        for op in operations:
            if not isinstance(op, dict):
                continue
            op_name = op.get("op")

            if op_name == "set":
                ws = get_sheet(wb, op.get("sheet"))
                cell = resolve_cell(ws, op.get("cell"))
                cell.value = op.get("value")
                changes += 1

            elif op_name == "add_row":
                ws = get_sheet(wb, op.get("sheet"))
                after = int(op.get("after", ws.max_row))
                idx = after + 1
                ws.insert_rows(idx)
                values = op.get("values") or []
                if isinstance(values, (list, tuple)):
                    for c, v in enumerate(values, 1):
                        ws.cell(row=idx, column=c, value=v)
                changes += 1

            elif op_name == "add_col":
                ws = get_sheet(wb, op.get("sheet"))
                after = int(op.get("after", ws.max_column))
                col = after + 1
                ws.insert_cols(col)
                header = op.get("header")
                if header is not None:
                    ws.cell(row=1, column=col, value=header)
                values = op.get("values") or []
                if isinstance(values, (list, tuple)):
                    for r, v in enumerate(values, 2):
                        ws.cell(row=r, column=col, value=v)
                changes += 1

            elif op_name == "delete_row":
                ws = get_sheet(wb, op.get("sheet"))
                row = int(op.get("row", 0))
                if row < 1:
                    raise ValueError('delete_row 缺少有效 row')
                ws.delete_rows(row)
                changes += 1

            elif op_name == "delete_col":
                ws = get_sheet(wb, op.get("sheet"))
                col = int(op.get("col", 0))
                if col < 1:
                    raise ValueError('delete_col 缺少有效 col')
                ws.delete_cols(col)
                changes += 1

            elif op_name == "set_width":
                ws = get_sheet(wb, op.get("sheet"))
                col = int(op.get("col", 1))
                width = float(op.get("width", 12))
                ws.column_dimensions[get_column_letter(col)].width = width
                changes += 1

            elif op_name == "add_sheet":
                name = str(op.get("name") or "新表").strip()
                wb.create_sheet(name)
                changes += 1

            elif op_name == "rename_sheet":
                ws = get_sheet(wb, op.get("sheet"))
                new_name = op.get("new_name")
                if not new_name:
                    raise ValueError('rename_sheet 缺少 new_name')
                ws.title = str(new_name)[:31]
                changes += 1

            # 未知操作直接跳过，避免一个错操作毁掉整批修改

        # 输出路径：output 缺省覆盖原文件；否则另存到工作区
        if output:
            ws_dir = os.environ.get("AGENT_WORKSPACE") or os.path.dirname(path_raw)
            out = output if os.path.isabs(output) else os.path.join(ws_dir, output)
            if not out.lower().endswith(".xlsx"):
                out += ".xlsx"
        else:
            out = path_raw

        wb.save(out)
        return "已修改 Excel：%s（改动了 %d 处）" % (out, changes)
    except Exception as e:
        return "编辑失败：" + str(e)
    finally:
        try:
            wb.close()
        except Exception:
            pass
