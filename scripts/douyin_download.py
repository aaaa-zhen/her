#!/usr/bin/env python3
"""Download Douyin videos using Playwright headless browser.

No browser MCP needed — uses Playwright to run a headless Chromium,
intercepts the video detail API, and downloads the video.

Usage:
    python3 douyin_download.py <douyin_url> [output_dir_or_path]

Requirements:
    pip install playwright && playwright install chromium
"""

import re
import sys
import json
import os
import subprocess
import urllib.request


def ensure_playwright():
    """Auto-install playwright and chromium if not present."""
    try:
        import playwright
        return
    except ImportError:
        print("[setup] Installing playwright...")
        subprocess.run([sys.executable, "-m", "pip", "install", "playwright"],
                       check=True, capture_output=True)

    # Install chromium browser
    print("[setup] Installing Chromium browser...")
    subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"],
                   check=True, capture_output=True)
    print("[setup] Done!")


def resolve_short_url(url: str) -> str:
    """Resolve v.douyin.com short links."""
    if "v.douyin.com" not in url:
        return url
    headers = {"User-Agent": "Mozilla/5.0"}
    req = urllib.request.Request(url, headers=headers, method="HEAD")
    try:
        resp = urllib.request.urlopen(req)
        return resp.url
    except urllib.error.HTTPError as e:
        if e.headers.get("Location"):
            return e.headers["Location"]
        raise


def extract_video_id(url: str) -> str:
    """Extract aweme_id from various Douyin URL formats."""
    for pattern in [r'/video/(\d+)', r'modal_id=(\d+)', r'/note/(\d+)']:
        m = re.search(pattern, url)
        if m:
            return m.group(1)
    raise ValueError(f"Cannot extract video ID from: {url}")


def fetch_video_info(video_id: str) -> dict:
    """Use Playwright to open Douyin page and intercept the detail API."""
    from playwright.sync_api import sync_playwright

    result = {}

    def handle_response(response):
        """Intercept the video detail API response."""
        if "aweme/v1/web/aweme/detail" in response.url and response.status == 200:
            try:
                data = response.json()
                aweme = data.get("aweme_detail", {})
                video = aweme.get("video", {})
                play_addr = video.get("play_addr", {})
                urls = play_addr.get("url_list", [])
                if urls:
                    result["play_url"] = urls[0]
                    result["desc"] = aweme.get("desc", "video")
            except Exception:
                pass

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/145.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080},
        )
        page = context.new_page()
        page.on("response", handle_response)

        url = f"https://www.douyin.com/video/{video_id}"
        page.goto(url, wait_until="domcontentloaded", timeout=30000)

        # Wait for the API response to be captured
        for _ in range(20):
            if "play_url" in result:
                break
            page.wait_for_timeout(1000)

        browser.close()

    if "play_url" not in result:
        raise RuntimeError("Failed to capture video URL from API response")

    return result


def sanitize_filename(name: str, max_len: int = 50) -> str:
    """Sanitize a string for use as filename."""
    name = re.sub(r'[\\/:*?"<>|\n\r\t]', '', name)
    name = re.sub(r'#\S+', '', name).strip()
    name = name[:max_len].strip()
    return name or "video"


def download_video(video_url: str, output_path: str):
    """Download video using curl."""
    cmd = [
        "curl", "-L", "-o", output_path,
        "-H", "Referer: https://www.douyin.com/",
        "-H", "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/145.0.0.0 Safari/537.36",
        "--progress-bar",
        video_url
    ]
    subprocess.run(cmd, check=True)


def get_video_info(path: str) -> str:
    """Get video info using ffprobe."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_format", "-show_streams", path],
            capture_output=True, text=True
        )
        data = json.loads(r.stdout)
        fmt = data["format"]
        lines = []
        for s in data["streams"]:
            if s["codec_type"] == "video":
                lines.append(f"  视频: {s['codec_name']} {s['width']}x{s['height']}")
            elif s["codec_type"] == "audio":
                lines.append(f"  音频: {s['codec_name']} {s['sample_rate']}Hz")
        dur = float(fmt["duration"])
        size_mb = int(fmt["size"]) / 1024 / 1024
        lines.append(f"  时长: {int(dur // 60)}分{int(dur % 60)}秒")
        lines.append(f"  大小: {size_mb:.1f}MB")
        return "\n".join(lines)
    except Exception:
        return "  (ffprobe not available)"


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <douyin_url> [output_path]")
        sys.exit(1)

    url = sys.argv[1]
    output_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.expanduser("~/Desktop")

    # Auto-install playwright if needed
    ensure_playwright()

    # Step 1: Resolve short URL
    print("[1/4] Resolving URL...")
    full_url = resolve_short_url(url)
    video_id = extract_video_id(full_url)
    print(f"  Video ID: {video_id}")

    # Step 2: Fetch video info via headless browser
    print("[2/4] Fetching video info (headless browser)...")
    info = fetch_video_info(video_id)
    desc = info.get("desc", "video")
    print(f"  Title: {desc}")

    # Step 3: Download
    filename = f"抖音_{sanitize_filename(desc)}.mp4"
    if os.path.isdir(output_dir):
        output_path = os.path.join(output_dir, filename)
    else:
        output_path = output_dir
    print(f"[3/4] Downloading to: {output_path}")
    download_video(info["play_url"], output_path)

    # Step 4: Verify
    print("[4/4] Done!")
    print(get_video_info(output_path))
    print(f"\nSaved: {output_path}")


if __name__ == "__main__":
    main()
