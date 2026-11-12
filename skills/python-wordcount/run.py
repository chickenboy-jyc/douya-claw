# Python 技能示例：文本统计
# 约定：def main(params) -> str，结果会原样回填给模型 / 显示在界面。
# 默认禁止联网（manifest.allowNetwork=false）。如确需联网，设为 true 并在脚本内使用 requests/urllib。

def main(params):
    text = params.get("text", "") or ""
    chars = len(text)
    lines = text.count("\n") + (1 if text else 0)
    # 按空白做简单分词（中文可按字符数近似）
    words = len([w for w in text.split() if w.strip()])
    return "字符数: {}\n词数(空白分词): {}\n行数: {}".format(chars, words, lines)
