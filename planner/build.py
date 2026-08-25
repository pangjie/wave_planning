#!/usr/bin/env python3
# 组装单文件版 HTML：head + body + 内联字体 + 内联 SheetJS + core + app
# 输出：本工程顶层的 波次规划工具.html，
#       并同步部署到 ../wms/project/frontend/dist/index.html（本地服务控制台页面）
import os
import re

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(BASE)
OUT = os.path.join(ROOT, "波次规划工具.html")
WMS_DIST = os.path.join(ROOT, "wms", "project", "frontend", "dist")

head = open(os.path.join(BASE, "part0-head.html"), encoding="utf-8").read()
body = open(os.path.join(BASE, "part1-body.html"), encoding="utf-8").read()
core = open(os.path.join(BASE, "core.js"), encoding="utf-8").read()
app = open(os.path.join(BASE, "app.js"), encoding="utf-8").read()
vendor = open(os.path.join(BASE, "vendor", "xlsx.full.min.js"), encoding="utf-8").read()
fonts = open(os.path.join(BASE, "part2-fonts.html"), encoding="utf-8").read()

# 防御性处理：vendor 中不应出现 </script（已验证为 0），如有则转义
vendor = re.sub(r"</(script)", r"<\\/\1", vendor, flags=re.IGNORECASE)

html = (
    head.replace("</head>", fonts + "</head>", 1)
    + body
    + "\n<script>\n/* === 内联 Excel 引擎（SheetJS Community Edition 0.20.3）=== */\n"
    + vendor
    + "\n</script>\n<script>\n"
    + core
    + "\n</script>\n<script>\n"
    + app
    + "\n</script>\n</html>\n"
)

with open(OUT, "w", encoding="utf-8") as f:
    f.write(html)

if os.path.isdir(WMS_DIST):
    with open(os.path.join(WMS_DIST, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)
    print(f"deployed {os.path.join(WMS_DIST, 'index.html')}")
else:
    print(f"(WMS frontend/dist 不存在，跳过部署：{WMS_DIST})")

print(f"written {OUT} ({len(html)} bytes)")
