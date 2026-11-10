#!/usr/bin/env python3
"""从当前 Open Orpheus 曲目读取 DMS 可用的同步歌词。"""

import http.client
import json
import math
import os
import re
import select
import subprocess
import sys
import time
import unicodedata
import xml.etree.ElementTree as ET
from contextlib import ExitStack
from urllib.parse import urlencode


BUS_NAME = "io.github.yucling.OpenOrpheus"
INTERFACE = BUS_NAME + ".Lyrics"
OBJECT_PATH = "/io/github/yucling/OpenOrpheus/Lyrics"
MPRIS_NAMES = ("org.mpris.MediaPlayer2.open-orpheus", "org.mpris.MediaPlayer2.io.github.yucling.open-orpheus")
NETEASE_HOST = "music.163.com"
LOOKUP_SECONDS = 5.5
TRACK_SETTLE_SECONDS = 0.8
MAX_NETEASE_RESPONSE = 512 * 1024


class Unavailable(Exception):
    """本次查询无法确认歌词归属，交给 DMS 的其他来源。"""


def bus_call(deadline, max_wait, destination, path, interface, method, *args):
    timeout = min(max_wait, deadline - time.monotonic())
    if timeout <= 0:
        raise Unavailable("D-Bus 查询超时")
    result = subprocess.run(
        ["busctl", "--user", "--json=short", "--auto-start=no",
         f"--timeout={timeout:.3f}s", "call", destination, path, interface, method, *args],
        capture_output=True, text=True, timeout=timeout + 0.2,
    )
    if result.returncode != 0:
        raise Unavailable("Open Orpheus 歌词服务未响应")
    return json.loads(result.stdout)["data"][0]


def track_properties(owner, deadline):
    props = bus_call(deadline, 0.4, owner, OBJECT_PATH,
                     "org.freedesktop.DBus.Properties", "GetAll", "s", INTERFACE)
    return {key: props[key]["data"] for key in ("TrackId", "Title", "Artist", "Album", "Duration")}


def normalized(value):
    return " ".join(unicodedata.normalize("NFKC", value or "").casefold().split())


def matches(request, track):
    if not track["TrackId"]:
        return False
    for key in ("Title", "Artist"):
        wanted = normalized(request.get(key.lower()))
        if not wanted or wanted != normalized(track[key]):
            return False
    wanted_album = normalized(request.get("album"))
    actual_album = normalized(track["Album"])
    if wanted_album and actual_album and wanted_album != actual_album:
        return False
    duration = request.get("duration") or 0
    return not (duration and track["Duration"] and abs(duration * 1000 - track["Duration"]) > 2000)


def wait_for_change(resources, monitor, owner, deadline):
    if monitor is None:
        # 仅监听这一实例的歌词接口，切歌和歌词更新都能提前结束等待。
        rule = f"type='signal',sender='{owner}',path='{OBJECT_PATH}',interface='{INTERFACE}'"
        monitor = resources.enter_context(subprocess.Popen(
            ["busctl", "--user", "--json=short", f"--match={rule}", "monitor"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        ))
        resources.callback(monitor.terminate)

    interval = min(0.25, max(0, deadline - time.monotonic()))
    # 补一次定时重查，覆盖监听尚未建立或被会话总线拒绝的情况。
    if monitor.poll() is None and select.select([monitor.stdout], [], [], interval)[0]:
        if not os.read(monitor.stdout.fileno(), 8192):
            time.sleep(interval)
    elif monitor.poll() is not None:
        time.sleep(interval)
    return monitor


def lookup(request):
    start = time.monotonic()
    deadline = start + LOOKUP_SECONDS
    owner = bus_call(deadline, 0.4, "org.freedesktop.DBus", "/org/freedesktop/DBus",
                     "org.freedesktop.DBus", "GetNameOwner", "s", BUS_NAME)

    matched_track = None
    with ExitStack() as resources:
        monitor = None
        while time.monotonic() < deadline:
            before = track_properties(owner, deadline)
            if matches(request, before):
                # 即使尚未 Available 也调用，支持按需获取后台歌词的版本。
                raw = bus_call(deadline - 0.4, 1.5, owner, OBJECT_PATH,
                               INTERFACE, "GetLyrics")
                after = track_properties(owner, deadline)
                document = json.loads(raw)
                if before["TrackId"] == after["TrackId"] and matches(request, after):
                    if document and (document.get("per-word") or document.get("regular")):
                        return to_ttml(document, after["Duration"])
                    matched_track = after
            if time.monotonic() >= start + TRACK_SETTLE_SECONDS:
                break
            matched_track = None
            monitor = wait_for_change(resources, monitor, owner, start + TRACK_SETTLE_SECONDS)

    if matched_track:
        return lookup_online(request, matched_track, owner, deadline)

    # 空的成功结果会被 DMS 缓存；未到词、换歌和无服务都只代表本次未确认。
    raise Unavailable("当前曲目的歌词尚未可用")


def mpris_has_track(object_id, deadline):
    for name in MPRIS_NAMES:
        try:
            metadata = bus_call(deadline, 0.35, name, "/org/mpris/MediaPlayer2",
                                "org.freedesktop.DBus.Properties", "Get", "ss",
                                "org.mpris.MediaPlayer2.Player", "Metadata")
        except Unavailable:
            continue
        if metadata["data"].get("mpris:trackid", {}).get("data") == object_id:
            return True
    return False


def netease_request(deadline, path, **params):
    timeout = min(1.8, deadline - time.monotonic())
    if timeout <= 0:
        raise Unavailable("网易云歌词查询超时")
    connection = http.client.HTTPSConnection(NETEASE_HOST, timeout=timeout)
    try:
        connection.request("GET", f"{path}?{urlencode(params)}", headers={
            "Referer": f"https://{NETEASE_HOST}/", "User-Agent": "Mozilla/5.0",
        })
        with connection.getresponse() as response:
            if response.status != 200:
                raise Unavailable("网易云歌词查询未成功")
            raw = response.read(MAX_NETEASE_RESPONSE + 1)
    finally:
        connection.close()
    if len(raw) > MAX_NETEASE_RESPONSE or time.monotonic() > deadline:
        raise Unavailable("网易云歌词查询超过限制")
    result = json.loads(raw)
    if result.get("code") != 200:
        raise Unavailable("网易云歌词查询未成功")
    return result


def catalog_matches(track, song):
    if str(song.get("id")) != track["TrackId"] or normalized(song.get("name")) != normalized(track["Title"]):
        return False
    names = [artist["name"] for artist in song.get("artists", [])]
    if not names or normalized(track["Artist"]) not in {
        normalized(sep.join(names)) for sep in ("/", " / ", ",", ", ", "、", " & ")
    }:
        return False
    album = normalized((song.get("album") or {}).get("name"))
    if album and track["Album"] and album != normalized(track["Album"]):
        return False
    duration = song.get("duration") or 0
    return not (duration and track["Duration"] and abs(duration - track["Duration"]) > 2000)


def lookup_online(request, track, owner, deadline):
    track_id = track["TrackId"]
    object_id = f"/com/163/music/{track_id}"
    if not re.fullmatch(r"[1-9][0-9]{0,18}", track_id) or not mpris_has_track(object_id, deadline):
        raise Unavailable("当前曲目无法对应到网易云在线歌曲")

    details = netease_request(deadline, "/api/song/detail/", id=track_id, ids=f"[{track_id}]")
    if not any(catalog_matches(track, song) for song in details.get("songs", [])):
        raise Unavailable("当前曲目未通过网易云歌曲校验")

    after = track_properties(owner, deadline)
    if after["TrackId"] != track_id or not matches(request, after):
        raise Unavailable("当前曲目已切换")
    result = netease_request(deadline, "/api/song/lyric/v1", id=track_id, lv=0)
    lyrics = (result.get("lrc") or {}).get("lyric") or ""
    if not re.search(r"(?m)^\s*\[\d+:\d{2}(?:\.\d+)?\]", lyrics):
        raise Unavailable("网易云没有提供逐行歌词")
    after = track_properties(owner, deadline)
    if after["TrackId"] != track_id or not matches(request, after) or not mpris_has_track(object_id, deadline):
        raise Unavailable("当前曲目已切换")
    return {"format": "lrc", "lyrics": lyrics}


def milliseconds(number):
    if type(number) not in (int, float) or not math.isfinite(number):
        raise ValueError("无效的歌词时间")
    return max(0, round(number))


def clean_text(value):
    # XML 1.0 只接受部分控制字符。
    return "".join(c for c in value if c in "\t\n\r" or " " <= c <= "\ud7ff"
                   or "\ue000" <= c <= "\ufffd" or c >= "\U00010000")


def to_ttml(document, duration):
    root = ET.Element("tt", xmlns="http://www.w3.org/ns/ttml")
    body = ET.SubElement(root, "body")
    if duration > 0:
        body.set("end", f"{duration}ms")
    section = ET.SubElement(body, "div")
    per_word = document.get("per-word")
    for line in per_word or document.get("regular", []):
        words = [(word, clean_text(word["text"])) for word in line["words"]]
        text = "".join(value for _, value in words)
        if not text.strip():
            continue
        start = milliseconds(line["start_time"])
        end = milliseconds(line["end_time"])
        paragraph = ET.SubElement(section, "p", begin=f"{start}ms")
        if end > start:
            paragraph.set("end", f"{end}ms")
        if not per_word:
            paragraph.text = text
            continue
        for word, value in words:
            if not value:
                continue
            # Open Orpheus 的字词时间相对当前行，DMS 的 TTML 使用曲内时间。
            absolute = line["start_time"] + word["start_time"]
            begin = milliseconds(absolute)
            word_end = milliseconds(absolute + word["duration"])
            span = ET.SubElement(paragraph, "span", begin=f"{begin}ms")
            if word_end > begin:
                span.set("end", f"{word_end}ms")
            span.text = value
    if not len(section):
        raise Unavailable("当前曲目没有可显示的歌词")
    return {"format": "ttml", "lyrics": ET.tostring(root, encoding="unicode")}


def main():
    try:
        result = lookup(json.load(sys.stdin))
        print(json.dumps(result, ensure_ascii=False))
    except (Unavailable, OSError, http.client.HTTPException, subprocess.SubprocessError,
            ValueError, KeyError, TypeError, IndexError) as error:
        print(f"Open Orpheus Lyrics: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
