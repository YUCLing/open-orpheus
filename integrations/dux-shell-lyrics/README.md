# Open Orpheus 歌词源

把 Open Orpheus 当前播放曲目的本地歌词接入 Dux Modular Shell 的原生歌词界面。DMS 通过 MPRIS 跟踪播放进度，插件从 Open Orpheus 的会话 D-Bus 读取歌词并转换为 TTML。有逐字歌词时保留逐字时间，只有普通歌词时保留逐行时间。当前输出原文，翻译和罗马音未接入。

需要 DMS 2.1.2 或更高版本、Open Orpheus 0.20.0 或更高版本，以及 Python 3 和带 JSON 输出的 `busctl`。播放器和 DMS 需要使用同一个 D-Bus 会话。Open Orpheus 0.20.0 可能只在打开它自己的桌面歌词或迷你播放器时向 D-Bus 发布歌词。若后台暂时没有发布，插件可针对核对通过的网易云在线歌曲取逐行歌词。

将 `plugin.json` 和可执行的 `fetch.py` 放在 `~/.config/dms/plugins/openOrpheusLyrics/`，到 DMS「设置 → 插件」扫描并启用插件，再到「声音和媒体 → 媒体播放器 → 歌词提供方」启用 Open Orpheus。切换曲目会触发下一次查询。若要单独验证这个来源，可以暂时关闭其他来源。

曲名、歌手、可用的专辑与时长只用于本地核对。在线回退会向 `music.163.com` 发送当前曲目的数字 ID，先核对网易云返回的曲目信息，再取歌词。不需要登录，不发送 Cookie 或本地路径。服务未运行、切歌尚未完成或暂时没有歌词时，本次查询失败，其他启用的来源仍可返回结果。

在插件目录运行 `python3 -B -m unittest discover -s tests -v`，可以离线检查切歌、延迟到达、逐字时间和在线回退的匹配规则。
