# 启动脚本测试专用最小服务，仅提供健康检查，不启动 WMS 自动化和截单调度。
"""Health-only fixture app, with no production WMS or file mutation routes."""

import os

from fastapi import FastAPI


app = FastAPI()


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/__test/runtime")
async def runtime():
    return {name: value for name, value in os.environ.items() if name.startswith("WMS_")}
