"""自主全流程测试：有头浏览器打开规划页 → 导入 sample 订单文件 →
勾选有头模式 → 点击“生成波次” → 等待任务完成 → 收集结果到 outputs/auto-run-result.json。"""
import asyncio
import base64
import json
from pathlib import Path

XLSX = Path(__file__).resolve().parents[2] / "sample" / "ParcelOutbound_20260815193913.xlsx"
OUT = Path(__file__).resolve().parents[1] / "outputs" / "auto-run-result.json"


async def main() -> None:
    b64 = base64.b64encode(XLSX.read_bytes()).decode()
    inject = (
        "(async () => {"
        f"const bin = atob('{b64}');"
        "const u8 = new Uint8Array(bin.length);"
        "for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);"
        "window.__dshTest.handleFile(new File([u8], 'ParcelOutbound_20260815193913.xlsx'));"
        "})()"
    )
    from playwright.async_api import async_playwright

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=False, channel="chrome")
        page = await browser.new_page(viewport={"width": 1920, "height": 950})
        await page.goto("http://127.0.0.1:8000/", timeout=30000)
        await page.wait_for_function(
            "window.__dshTest && window.__dshTest.wms && window.__dshTest.wms.available === true",
            timeout=20000,
        )
        print("[driver] 页面加载，WMS 服务在线", flush=True)

        await page.evaluate(inject)
        await page.wait_for_function(
            "window.__dshTest.state.records.length > 0", timeout=30000
        )
        n = await page.evaluate("window.__dshTest.state.records.length")
        segs = await page.evaluate(
            "window.__dshTest.curAnalysis().channels.map(c => ({"
            "ch: c.id, segs: c.segments.map(s => s.name + '(' + s.orderNos.length + ')'"
            ")}))"
        )
        print(f"[driver] 导入成功：{n} 条订单", flush=True)
        print("[driver] 分段结构:", json.dumps(segs, ensure_ascii=False), flush=True)

        # 有头模式（点击浏览器模式切换字符，从无头切到有头）
        await page.evaluate(
            "if (window.__dshTest.wms.headless) document.getElementById('browserModeVal').click()"
        )
        print("[driver] 已选择有头模式，点击“生成波次”", flush=True)
        await page.evaluate("document.getElementById('wmsGenerate').click()")

        await page.wait_for_function(
            "(() => { const w = window.__dshTest.wms; "
            "return w.job && ['succeeded','partial','failed','cancelled'].indexOf(w.job.status) !== -1; })()",
            timeout=90 * 60 * 1000,
        )
        await page.wait_for_timeout(8000)  # 等待自动导出与记录同步

        info = await page.evaluate(
            """(() => {
                const w = window.__dshTest.wms;
                const st = window.__dshTest.state;
                const links = [...document.querySelectorAll('#wmsLog a')]
                    .map(a => ({ text: a.textContent, href: a.getAttribute('href') }));
                return JSON.stringify({
                    status: w.job ? w.job.status : null,
                    message: w.job && w.job.result ? w.job.result.message : '',
                    error: w.job ? (w.job.error || '') : '',
                    generated: w.job && w.job.result ? w.job.result.generated_count : null,
                    failed: w.job && w.job.result ? w.job.result.failed_count : null,
                    waveNos: [...st.waveNos.entries()],
                    wavedCount: document.querySelectorAll('#dash .seg-line.waved').length,
                    links: links
                });
            })()"""
        )
        print("[driver] RESULT:", info, flush=True)
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(info, encoding="utf-8")
        await browser.close()


asyncio.run(main())
