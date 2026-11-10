import json
import unittest
import xml.etree.ElementTree as ET
from unittest.mock import patch

import fetch


REQUEST = {"title": "测试歌曲", "artist": "歌手甲 / 歌手乙", "album": "测试专辑", "duration": 121}
TRACK = {"TrackId": "123", "Title": "测试歌曲", "Artist": "歌手甲 / 歌手乙",
         "Album": "测试专辑", "Duration": 121500}
NEXT_TRACK = {**TRACK, "TrackId": "124", "Title": "另一首歌"}
DOCUMENT = {"per-word": [{"start_time": 1234, "end_time": 3200, "words": [
    {"text": "测试", "start_time": 0, "duration": 321},
    {"text": " & 歌", "start_time": 700, "duration": 654},
]}]}
CATALOG = {"songs": [{"id": 123, "name": "测试歌曲", "artists": [{"name": "歌手甲"}, {"name": "歌手乙"}],
                      "album": {"name": "测试专辑"}, "duration": 121500}]}
LRC = "[00:01.234]测试 & 歌"


class LookupTests(unittest.TestCase):
    def test_waits_for_lyrics_then_keeps_word_timing(self):
        with (
            patch.object(fetch.time, "monotonic", side_effect=[0, 0.1, 0.2, 0.4]),
            patch.object(fetch, "bus_call", side_effect=[":1.2", "null", json.dumps(DOCUMENT)]),
            patch.object(fetch, "track_properties", return_value=TRACK),
            patch.object(fetch, "wait_for_change") as wait,
            patch.object(fetch, "lookup_online") as online,
        ):
            result = fetch.lookup(REQUEST)
        wait.assert_called_once()
        online.assert_not_called()
        self.assertEqual(result["format"], "ttml")
        nodes = ET.fromstring(result["lyrics"]).findall(".//{*}span")
        self.assertEqual([(x.text, x.get("begin"), x.get("end")) for x in nodes], [
            ("测试", "1234ms", "1555ms"), (" & 歌", "1934ms", "2588ms"),
        ])

    def test_discards_old_lyrics_if_track_changes_during_call(self):
        with (
            patch.object(fetch.time, "monotonic", side_effect=[0, 0.1, 0.9]),
            patch.object(fetch, "bus_call", side_effect=[":1.2", json.dumps(DOCUMENT)]),
            patch.object(fetch, "track_properties", side_effect=[TRACK, NEXT_TRACK]),
            patch.object(fetch, "lookup_online") as online,
            self.assertRaises(fetch.Unavailable),
        ):
            fetch.lookup(REQUEST)
        online.assert_not_called()

    def test_online_fallback_returns_verified_lrc(self):
        with (
            patch.object(fetch, "mpris_has_track", return_value=True) as mpris,
            patch.object(fetch, "track_properties", return_value=TRACK),
            patch.object(fetch, "netease_request", side_effect=[CATALOG, {"lrc": {"lyric": LRC}}]) as online,
        ):
            result = fetch.lookup_online(REQUEST, TRACK, ":1.2", 10)
        self.assertEqual(result, {"format": "lrc", "lyrics": LRC})
        self.assertEqual(mpris.call_count, 2)
        self.assertEqual([call.args[1] for call in online.call_args_list], ["/api/song/detail/", "/api/song/lyric/v1"])
        self.assertTrue(all(call.kwargs["id"] == "123" for call in online.call_args_list))

    def test_local_id_or_mpris_mismatch_does_not_use_network(self):
        for track in ({**TRACK, "TrackId": "track-123"}, TRACK):
            with (
                self.subTest(track_id=track["TrackId"]),
                patch.object(fetch, "mpris_has_track", return_value=False),
                patch.object(fetch, "netease_request") as online,
                self.assertRaises(fetch.Unavailable),
            ):
                fetch.lookup_online(REQUEST, track, ":1.2", 10)
            online.assert_not_called()

    def test_catalog_mismatch_does_not_fetch_lyrics(self):
        wrong_song = {"songs": [{**CATALOG["songs"][0], "name": "同 ID 的其他内容"}]}
        with (
            patch.object(fetch, "mpris_has_track", return_value=True),
            patch.object(fetch, "netease_request", return_value=wrong_song) as online,
            self.assertRaises(fetch.Unavailable),
        ):
            fetch.lookup_online(REQUEST, TRACK, ":1.2", 10)
        online.assert_called_once_with(10, "/api/song/detail/", id="123", ids="[123]")

    def test_online_result_is_discarded_after_track_switch(self):
        with (
            patch.object(fetch, "mpris_has_track", return_value=True),
            patch.object(fetch, "track_properties", side_effect=[TRACK, NEXT_TRACK]),
            patch.object(fetch, "netease_request", side_effect=[CATALOG, {"lrc": {"lyric": LRC}}]),
            self.assertRaises(fetch.Unavailable),
        ):
            fetch.lookup_online(REQUEST, TRACK, ":1.2", 10)


if __name__ == "__main__":
    unittest.main()
