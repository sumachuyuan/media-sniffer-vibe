import asyncio
from playwright.async_api import async_playwright
import os

async def run_debug():
    extension_path = "/Users/huyuanlong/works/github/media-sniffer-vibe/extension"
    
    async with async_playwright() as p:
        # Launch browser with extension
        browser_context = await p.chromium.launch_persistent_context(
            "",
            headless=False,
            args=[
                f"--disable-extensions-except={extension_path}",
                f"--load-extension={extension_path}",
                "--no-sandbox",
            ]
        )
        
        # 1. Discover Extension ID via chrome://extensions
        print("Discovering extension ID...")
        admin_page = await browser_context.new_page()
        await admin_page.goto("chrome://extensions")
        await admin_page.wait_for_load_state("networkidle")
        
        # In chrome://extensions, the ID is in the DOM
        # We can extract it by looking for the name or just parsing all of them
        # Alternatively, we can just look for the first non-internal extension
        extension_id = await admin_page.evaluate("""() => {
            const items = document.querySelector('extensions-manager').shadowRoot
                .querySelector('extensions-item-list').shadowRoot
                .querySelectorAll('extensions-item');
            for (const item of items) {
                if (!item.shadowRoot.querySelector('#name').textContent.includes('Chrome')) {
                    return item.id;
                }
            }
            return null;
        }""")
        
        if not extension_id:
            # Fallback for some versions
            extension_id = await admin_page.evaluate("""() => {
                const url = window.location.href;
                if (url.includes('id=')) return url.split('id=')[1];
                return null;
            }""")

        if not extension_id:
            print("Failed to discover extension ID from chrome://extensions. Trying service workers...")
            await asyncio.sleep(2)
            for sw in browser_context.service_workers:
                if "extension" in sw.url:
                    extension_id = sw.url.split("/")[2]
                    break

        if not extension_id:
            print("STILL failed to find extension ID. Closing.")
            await browser_context.close()
            return

        print(f"DEBUG: EXTENSION_ID is {extension_id}")

        # 2. Setup Console Logging for all pages
        async def setup_logs(page):
            print(f"[PAGE] {page.url}")
            page.on("console", lambda msg: print(f"[{page.url}] {msg.type.upper()}: {msg.text}"))
            page.on("pageerror", lambda err: print(f"[{page.url}] ERROR: {err}"))

        browser_context.on("page", setup_logs)
        for page in browser_context.pages:
            await setup_logs(page)

        # 3. Visit test page
        test_page = await browser_context.new_page()
        await test_page.goto("https://www.wikipedia.org")
        await test_page.wait_for_load_state("networkidle")
        print("Test page loaded.")

        # 4. Open Popup as a page for debugging
        popup_url = f"chrome-extension://{extension_id}/popup.html"
        popup_page = await browser_context.new_page()
        await popup_page.goto(popup_url)
        await popup_page.wait_for_load_state("networkidle")
        print("Popup loaded.")

        # 5. Intercept the start recording button click
        print("Clicking Start Recording...")
        start_btn = popup_page.locator("#record-start-btn")
        await start_btn.click()
        
        # 6. Wait for recording to start and check for offscreen
        print("Waiting for errors/offscreen (10s)...")
        for _ in range(20):
            await asyncio.sleep(0.5)
            # Check if any new page is our offscreen
            for page in browser_context.pages:
                if "offscreen.html" in page.url:
                    print("!!! FOUND OFFSCREEN PAGE !!!")
                    await page.screenshot(path="/Users/huyuanlong/works/github/media-sniffer-vibe/scripts/screenshot_offscreen.png")
        
        await popup_page.screenshot(path="/Users/huyuanlong/works/github/media-sniffer-vibe/scripts/screenshot_popup_result.png")
        print("Snapshots saved.")

        await browser_context.close()

if __name__ == "__main__":
    asyncio.run(run_debug())
