#!/usr/bin/env python3
"""Import ordered YouTube links into the generated course map."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse


def parse_links(path: Path) -> tuple[list[dict], dict[int, list[dict]]]:
    intro: list[dict] = []
    sessions: dict[int, list[dict]] = {}
    current_session: int | None = None
    pending_title: str | None = None

    for raw_line in path.read_text(encoding="utf-8").splitlines():
      line = raw_line.strip()
      if not line:
          continue

      heading = re.match(r"^##\s+Session\s+(\d+):", line)
      if heading:
          current_session = int(heading.group(1))
          sessions.setdefault(current_session, [])
          pending_title = None
          continue

      if line.startswith("## "):
          current_session = None
          pending_title = None
          continue

      item = re.match(r"^\d+\.\s+(.*)$", line)
      if item:
          pending_title = item.group(1).strip()
          continue

      if "youtube.com/embed/" in line:
          bucket = sessions.setdefault(current_session, []) if current_session else intro
          title = pending_title or f"Video {len(bucket) + 1}"
          bucket.append(video_item(title, line, len(bucket) + 1))
          pending_title = None

    return intro, sessions


def video_item(title: str, url: str, order: int) -> dict:
    parsed = urlparse(url)
    video_id = parsed.path.rstrip("/").split("/")[-1]
    query = parse_qs(parsed.query)
    start = first_int(query.get("start"))
    end = first_int(query.get("end"))
    watch_query = {"v": video_id}
    if start is not None:
        watch_query["t"] = f"{start}s"

    return {
        "order": order,
        "title": clean_title(title),
        "url": url,
        "embedUrl": url,
        "watchUrl": f"https://www.youtube.com/watch?{urlencode(watch_query)}",
        "youtubeKey": video_id,
        "startSeconds": start,
        "endSeconds": end,
        "source": "ordered-youtube-links",
    }


def clean_title(title: str) -> str:
    title = re.sub(r"\s+—\s+start\s+\d+s,\s+end\s+\d+s$", "", title)
    return re.sub(r"\s+", " ", title).strip()


def first_int(values: list[str] | None) -> int | None:
    if not values:
        return None
    try:
        return int(values[0])
    except ValueError:
        return None


def flatten_lessons(course_map: dict) -> list[dict]:
    return [
        lesson
        for module in course_map["modules"]
        for part in module["parts"]
        for lesson in part["lessons"]
    ]


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: scripts/import_youtube_links.py /path/to/pasted-text.txt")

    source_path = Path(sys.argv[1])
    course_map_path = Path("course-map.json")
    site_data_path = Path("site-data.js")

    course_map = json.loads(course_map_path.read_text(encoding="utf-8"))
    intro, session_videos = parse_links(source_path)
    lessons = flatten_lessons(course_map)
    matched = 0

    course_map["course"]["introVideos"] = intro
    course_map.setdefault("sourceFilesFound", {})["orderedYoutubeLinks"] = str(source_path)

    for lesson in lessons:
        session_number = lesson.get("sessionNumber")
        videos = session_videos.get(session_number, [])
        youtube = lesson.setdefault("youtube", {})
        youtube["defaultVideos"] = videos
        youtube["defaultVideoUrl"] = videos[0]["url"] if videos else ""
        youtube["defaultVideoTitle"] = videos[0]["title"] if videos else ""
        if videos:
            matched += 1

    course_map.setdefault("counts", {})["orderedYoutubeSessions"] = matched
    course_map.setdefault("counts", {})["orderedYoutubeVideos"] = sum(len(videos) for videos in session_videos.values())
    course_map.setdefault("counts", {})["introYoutubeVideos"] = len(intro)

    json_text = json.dumps(course_map, indent=2, ensure_ascii=True)
    course_map_path.write_text(json_text + "\n", encoding="utf-8")
    site_data_path.write_text("window.COURSE_MAP = " + json_text + ";\n", encoding="utf-8")

    missing = sorted(set(session_videos) - {lesson.get("sessionNumber") for lesson in lessons})
    print(
        json.dumps(
            {
                "matchedSessions": matched,
                "orderedYoutubeVideos": course_map["counts"]["orderedYoutubeVideos"],
                "introVideos": len(intro),
                "missingSessionMatches": missing,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
