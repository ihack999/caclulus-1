#!/usr/bin/env python3
"""Build a self-study course map from the local MIT OCW offline package."""

from __future__ import annotations

import json
import re
from collections import defaultdict
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import unquote


ROOT = Path("ocw-source")
PAGES = ROOT / "pages"
RESOURCES = ROOT / "resources"
STATIC = ROOT / "static_resources"

MODULE_ORDER = [
    "1.-differentiation",
    "unit-2-applications-of-differentiation",
    "unit-3-the-definite-integral-and-its-applications",
    "unit-4-techniques-of-integration",
    "unit-5-exploring-the-infinite",
    "final-exam",
]

TOPIC_BY_MODULE = {
    "1.-differentiation": "Limits, continuity, and derivatives",
    "unit-2-applications-of-differentiation": "Derivative applications",
    "unit-3-the-definite-integral-and-its-applications": "Integrals and applications",
    "unit-4-techniques-of-integration": "Integration techniques and coordinates",
    "unit-5-exploring-the-infinite": "Improper integrals and infinite series",
    "final-exam": "Cumulative exam preparation",
}


class LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[dict[str, str]] = []
        self._href: str | None = None
        self._text_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        attrs_dict = dict(attrs)
        href = attrs_dict.get("href")
        if href:
            self._href = href
            self._text_parts = []

    def handle_data(self, data: str) -> None:
        if self._href is not None:
            self._text_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._href is not None:
            text = clean_text(" ".join(self._text_parts))
            self.links.append({"href": self._href, "text": text})
            self._href = None
            self._text_parts = []


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def clean_text(value: str | None) -> str:
    if not value:
        return ""
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def local_file_path(course_file: str | None) -> str | None:
    if not course_file:
        return None
    name = Path(course_file).name
    path = STATIC / name
    return path.as_posix() if path.exists() else None


def main_html(path: Path) -> str:
    if not path.exists():
        return ""
    html = path.read_text(encoding="utf-8", errors="ignore")
    match = re.search(
        r'<main\s+id=["\']course-content-section["\'][^>]*>(.*?)</main>',
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    return match.group(1) if match else html


def links_from_page(path: Path) -> list[dict[str, str]]:
    parser = LinkParser()
    parser.feed(main_html(path))
    return parser.links


def resource_slug(href: str) -> str | None:
    href = unquote(href.split("#", 1)[0])
    match = re.search(r"(?:^|/)resources/([^/]+)/index\.html$", href)
    return match.group(1) if match else None


def natural_key(value: str) -> list[Any]:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", value)]


def session_number(title_or_slug: str) -> int | None:
    match = re.search(r"session[- ]+(\d+)", title_or_slug, flags=re.IGNORECASE)
    return int(match.group(1)) if match else None


def problem_set_number(title_or_slug: str) -> int | None:
    match = re.search(r"problem[- ]+set[- ]+(\d+)", title_or_slug, flags=re.IGNORECASE)
    return int(match.group(1)) if match else None


def lesson_type(title: str, slug: str) -> str:
    text = f"{title} {slug}".lower()
    if "final exam" in text:
        return "final-exam"
    if "exam" in text:
        return "exam-prep"
    if "problem set" in text:
        return "problem-set"
    return "lesson"


def stage_for_lesson(title: str, number: int | None, kind: str) -> str:
    text = title.lower()
    if kind == "final-exam" or "final exam" in text:
        return "Final exam prep"
    if "exam" in text:
        return "Exam prep"
    if kind == "problem-set":
        return "Practice"
    if number in {4, 5, 8, 19}:
        return "Limits"
    if number is not None and 1 <= number <= 22:
        return "Derivatives"
    if number is not None and 23 <= number <= 42:
        return "Derivative applications"
    if number is not None and 43 <= number <= 67:
        return "Integrals"
    if number is not None and 68 <= number <= 86:
        return "Integration techniques"
    if number is not None and 87 <= number <= 93:
        return "Improper integrals"
    if number is not None and 94 <= number <= 101:
        return "Series"
    return "Course flow"


def resource_item(slug: str, meta: dict[str, Any]) -> dict[str, Any]:
    youtube_key = meta.get("youtube_key")
    return {
        "title": clean_text(meta.get("title")),
        "resourcePage": (RESOURCES / slug / "index.html").as_posix(),
        "filePath": local_file_path(meta.get("file")),
        "sourceFile": meta.get("file"),
        "learningResourceTypes": meta.get("learning_resource_types") or [],
        "resourceType": meta.get("resource_type"),
        "fileType": meta.get("file_type"),
        "youtubeKey": youtube_key,
        "youtubeUrl": f"https://www.youtube.com/watch?v={youtube_key}" if youtube_key else None,
        "archiveUrl": meta.get("archive_url"),
    }


def resource_is_pdf(item: dict[str, Any]) -> bool:
    return bool(item.get("filePath")) and str(item.get("fileType", "")).lower() == "application/pdf"


def resource_bucket(item: dict[str, Any], link_text: str = "") -> str | None:
    title = str(item.get("title", "")).lower()
    text = f"{title} {link_text}".lower()
    types = {str(t).lower() for t in item.get("learningResourceTypes", [])}
    if item.get("youtubeKey"):
        return "videos"
    if not resource_is_pdf(item):
        return None
    if "exam solutions" in types or ("exam" in text and "sol" in title):
        return "examSolutions"
    if "exams" in types or re.search(r"(exam|final)", text):
        return "exams"
    if "lecture notes" in types or "reading" in link_text.lower():
        return "notes"
    if "problem set solutions" in types or "solution" in text or re.search(r"sol\.pdf$", title):
        return "solutions"
    if "problem sets" in types or "problem" in text or re.search(r"prb\.pdf$", title):
        return "problems"
    return "documents"


def dedupe_resources(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    deduped: list[dict[str, Any]] = []
    for item in items:
        key = item.get("filePath") or item.get("resourcePage") or item.get("title")
        if key and key not in seen:
            seen.add(key)
            deduped.append(item)
    return deduped


def first_path(items: list[dict[str, Any]]) -> str | None:
    for item in items:
        if item.get("filePath"):
            return item["filePath"]
    return None


def load_resources() -> tuple[dict[str, dict[str, Any]], dict[int, list[dict[str, Any]]]]:
    resources: dict[str, dict[str, Any]] = {}
    notes_by_session: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for data_path in sorted(RESOURCES.glob("*/data.json")):
        slug = data_path.parent.name
        meta = load_json(data_path)
        item = resource_item(slug, meta)
        resources[slug] = item
        title = str(item.get("title", ""))
        if "Lecture Notes" in item.get("learningResourceTypes", []) and resource_is_pdf(item):
            match = re.search(r"ses(\d+)[a-z]?", title, flags=re.IGNORECASE)
            if match:
                notes_by_session[int(match.group(1))].append(item)

    for session, notes in notes_by_session.items():
        notes_by_session[session] = sorted(notes, key=lambda item: natural_key(item["title"]))
    return resources, notes_by_session


def collect_page_resources(page_path: Path, resources: dict[str, dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for link in links_from_page(page_path):
        slug = resource_slug(link["href"])
        if not slug or slug not in resources:
            continue
        item = resources[slug]
        bucket = resource_bucket(item, link["text"])
        if bucket:
            buckets[bucket].append(item)
    return {key: dedupe_resources(value) for key, value in buckets.items()}


def lesson_from_path(
    path: Path,
    module_title: str,
    module_id: str,
    part_title: str,
    resources: dict[str, dict[str, Any]],
    notes_by_session: dict[int, list[dict[str, Any]]],
) -> dict[str, Any]:
    data = load_json(path / "data.json")
    title = clean_text(data.get("title"))
    slug = path.name
    number = session_number(title) or session_number(slug)
    pset_number = problem_set_number(title) or problem_set_number(slug)
    kind = lesson_type(title, slug)
    buckets = collect_page_resources(path / "index.html", resources)
    notes = list(buckets.get("notes", []))
    if number is not None:
        notes.extend(notes_by_session.get(number, []))
    notes = dedupe_resources(notes)
    problems = dedupe_resources(buckets.get("problems", []))
    solutions = dedupe_resources(buckets.get("solutions", []))
    exams = dedupe_resources(buckets.get("exams", []))
    exam_solutions = dedupe_resources(buckets.get("examSolutions", []))
    videos = dedupe_resources(buckets.get("videos", []))
    lesson_id = path.relative_to(PAGES).as_posix()

    return {
        "id": lesson_id,
        "moduleId": module_id,
        "moduleTitle": module_title,
        "partTitle": part_title,
        "topic": stage_for_lesson(title, number, kind),
        "lessonType": kind,
        "lessonTitle": title,
        "sessionNumber": number,
        "problemSetNumber": pset_number,
        "sourcePagePath": (path / "index.html").as_posix(),
        "notesPdfPath": first_path(notes),
        "notesPdfPaths": [item["filePath"] for item in notes if item.get("filePath")],
        "problemPdfPath": first_path(problems),
        "problemPdfPaths": [item["filePath"] for item in problems if item.get("filePath")],
        "solutionPdfPath": first_path(solutions),
        "solutionPdfPaths": [item["filePath"] for item in solutions if item.get("filePath")],
        "examLinks": exams + exam_solutions,
        "resources": {
            "notes": notes,
            "problems": problems,
            "solutions": solutions,
            "exams": exams,
            "examSolutions": exam_solutions,
            "videos": videos,
            "documents": dedupe_resources(buckets.get("documents", [])),
        },
        "youtube": {
            "customUrl": "",
            "placeholder": "Paste your preferred lesson YouTube URL here.",
            "detectedOcwVideos": videos,
        },
    }


def child_sort_key(path: Path) -> tuple[int, list[Any]]:
    name = path.name
    if name.startswith("part-a"):
        group = 10
    elif name.startswith("part-b"):
        group = 20
    elif name.startswith("part-c"):
        group = 30
    elif name.startswith("part-d"):
        group = 40
    elif name.startswith("exam"):
        group = 90
    else:
        group = 50
    return (group, natural_key(name))


def lesson_sort_key(path: Path) -> tuple[int, int, list[Any]]:
    data_path = path / "data.json"
    title = load_json(data_path).get("title", "") if data_path.exists() else path.name
    number = session_number(str(title)) or session_number(path.name)
    pset = problem_set_number(str(title)) or problem_set_number(path.name)
    if number is not None:
        return (0, number, natural_key(path.name))
    if pset is not None:
        return (1, pset, natural_key(path.name))
    return (2, 0, natural_key(path.name))


def build_module(
    module_dir: Path,
    resources: dict[str, dict[str, Any]],
    notes_by_session: dict[int, list[dict[str, Any]]],
) -> dict[str, Any]:
    data = load_json(module_dir / "data.json")
    module_id = module_dir.name
    title = "Final Exam" if module_id == "final-exam" else clean_text(data.get("title"))
    module = {
        "id": module_id,
        "title": title,
        "topic": TOPIC_BY_MODULE.get(module_id, title),
        "sourcePagePath": (module_dir / "index.html").as_posix(),
        "parts": [],
        "examLinks": [],
    }

    if module_id == "final-exam":
        lesson = lesson_from_path(module_dir, title, module_id, "Final Exam", resources, notes_by_session)
        module["parts"].append(
            {
                "id": f"{module_id}/final-exam",
                "title": "Final Exam",
                "topic": "Cumulative exam preparation",
                "sourcePagePath": (module_dir / "index.html").as_posix(),
                "lessons": [lesson],
            }
        )
        module["examLinks"] = lesson["examLinks"]
        return module

    child_dirs = [
        child
        for child in module_dir.iterdir()
        if child.is_dir() and (child / "data.json").exists() and (child / "index.html").exists()
    ]
    for part_dir in sorted(child_dirs, key=child_sort_key):
        part_data = load_json(part_dir / "data.json")
        part_title = clean_text(part_data.get("title"))
        lesson_dirs = [
            child
            for child in part_dir.iterdir()
            if child.is_dir() and (child / "data.json").exists() and (child / "index.html").exists()
        ]
        lessons = [
            lesson_from_path(lesson_dir, title, module_id, part_title, resources, notes_by_session)
            for lesson_dir in sorted(lesson_dirs, key=lesson_sort_key)
        ]
        part = {
            "id": part_dir.relative_to(PAGES).as_posix(),
            "title": part_title,
            "topic": TOPIC_BY_MODULE.get(module_id, title),
            "sourcePagePath": (part_dir / "index.html").as_posix(),
            "lessons": lessons,
        }
        module["parts"].append(part)
        for lesson in lessons:
            module["examLinks"].extend(lesson["resources"]["exams"])
            module["examLinks"].extend(lesson["resources"]["examSolutions"])

    module["examLinks"] = dedupe_resources(module["examLinks"])
    return module


def flatten_lessons(modules: list[dict[str, Any]]) -> list[dict[str, Any]]:
    lessons: list[dict[str, Any]] = []
    for module in modules:
        for part in module["parts"]:
            lessons.extend(part["lessons"])
    return lessons


def lesson_refs(lessons: list[dict[str, Any]], start: int, end: int) -> list[str]:
    return [
        lesson["id"]
        for lesson in lessons
        if lesson.get("sessionNumber") is not None and start <= lesson["sessionNumber"] <= end
    ]


def problem_refs(lessons: list[dict[str, Any]], *numbers: int) -> list[str]:
    wanted = set(numbers)
    return [
        lesson["id"]
        for lesson in lessons
        if lesson.get("problemSetNumber") in wanted or lesson.get("lessonType") in {"exam-prep", "final-exam"}
        and lesson.get("sessionNumber") in wanted
    ]


def build_study_path(lessons: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "id": "precalculus-review",
            "title": "Pre-calculus review",
            "focus": "Algebra, functions, graphing, exponent rules, logarithms, and trigonometry.",
            "lessonRefs": [],
            "note": "The OCW syllabus lists high school algebra and trigonometry as prerequisites; this review block is a personal-study warmup before Session 1.",
        },
        {
            "id": "limits",
            "title": "Limits",
            "focus": "Limits, continuity, discontinuity, and special trigonometric limits.",
            "lessonRefs": [
                lesson["id"]
                for lesson in lessons
                if lesson.get("sessionNumber") in {4, 5, 8, 19}
            ],
        },
        {
            "id": "derivatives",
            "title": "Derivatives",
            "focus": "Definition of derivative, derivative rules, trig derivatives, implicit differentiation, exponentials, and logarithms.",
            "lessonRefs": lesson_refs(lessons, 1, 22),
        },
        {
            "id": "derivative-applications",
            "title": "Derivative applications",
            "focus": "Approximation, curve sketching, optimization, related rates, Newton's method, MVT, and differential equations.",
            "lessonRefs": lesson_refs(lessons, 23, 42),
        },
        {
            "id": "integrals",
            "title": "Integrals",
            "focus": "Definite integrals, Riemann sums, the Fundamental Theorem of Calculus, areas, volumes, averages, probability, and numerical integration.",
            "lessonRefs": lesson_refs(lessons, 43, 67),
        },
        {
            "id": "integration-techniques",
            "title": "Integration techniques",
            "focus": "Trigonometric integrals, substitution, partial fractions, integration by parts, arc length, surface area, parametric curves, and polar coordinates.",
            "lessonRefs": lesson_refs(lessons, 68, 86),
        },
        {
            "id": "series",
            "title": "Series",
            "focus": "L'Hospital's rule, improper integrals, infinite series, power series, and Taylor series.",
            "lessonRefs": lesson_refs(lessons, 87, 101),
        },
    ]


def build_weekly_plan(lessons: list[dict[str, Any]]) -> list[dict[str, Any]]:
    weeks = [
        ("Week 0", "Pre-calculus review", []),
        ("Week 1", "Derivative foundations and limits", lesson_refs(lessons, 1, 5)),
        ("Week 2", "Differentiation rules and trigonometric derivatives", lesson_refs(lessons, 6, 12)),
        ("Week 3", "Implicit differentiation, exponentials, and Exam 1", lesson_refs(lessons, 13, 22)),
        ("Week 4", "Approximation and graph sketching", lesson_refs(lessons, 23, 28)),
        ("Week 5", "Optimization, related rates, and Newton's method", lesson_refs(lessons, 29, 34)),
        ("Week 6", "MVT, antiderivatives, differential equations, and Exam 2", lesson_refs(lessons, 35, 42)),
        ("Week 7", "Definite integrals and FTC I", lesson_refs(lessons, 43, 50)),
        ("Week 8", "FTC II, area, and volume", lesson_refs(lessons, 51, 59)),
        ("Week 9", "Averages, probability, numerical integration, and Exam 3", lesson_refs(lessons, 60, 67)),
        ("Week 10", "Trigonometric powers and substitution", lesson_refs(lessons, 68, 73)),
        ("Week 11", "Partial fractions, integration by parts, arc length, and surface area", lesson_refs(lessons, 74, 79)),
        ("Week 12", "Parametric curves, polar coordinates, and Exam 4", lesson_refs(lessons, 80, 86)),
        ("Week 13", "L'Hospital's rule and improper integrals", lesson_refs(lessons, 87, 93)),
        ("Week 14", "Infinite series and Taylor series", lesson_refs(lessons, 94, 101)),
        (
            "Week 15",
            "Final exam prep",
            [lesson["id"] for lesson in lessons if lesson.get("lessonType") == "final-exam"],
        ),
    ]
    return [{"week": week, "title": title, "lessonRefs": refs} for week, title, refs in weeks]


def build_map() -> dict[str, Any]:
    course = load_json(ROOT / "data.json")
    image_src = course.get("image_src")
    image_path = None
    if isinstance(image_src, str) and image_src.startswith("./"):
        image_path = (ROOT / image_src[2:]).as_posix()
    resources, notes_by_session = load_resources()
    modules = [
        build_module(PAGES / module_id, resources, notes_by_session)
        for module_id in MODULE_ORDER
        if (PAGES / module_id / "data.json").exists()
    ]
    lessons = flatten_lessons(modules)
    problem_sets = [lesson for lesson in lessons if lesson["lessonType"] == "problem-set"]
    exams = [
        lesson
        for lesson in lessons
        if lesson["lessonType"] in {"exam-prep", "final-exam"} or lesson["resources"]["exams"]
    ]
    return {
        "course": {
            "title": "Engineering Calculus 1 Self-Study",
            "sourceCourseTitle": course.get("course_title"),
            "sourceCourseNumber": course.get("primary_course_number"),
            "term": course.get("term"),
            "year": course.get("year"),
            "sourceRoot": ROOT.as_posix(),
            "originalIndex": (ROOT / "index.html").as_posix(),
            "imagePath": image_path,
            "attribution": "Adapted as a personal study dashboard from MIT OpenCourseWare 18.01SC Single Variable Calculus, Fall 2010.",
            "license": "Creative Commons BY-NC-SA 4.0",
            "licenseUrl": "https://creativecommons.org/licenses/by-nc-sa/4.0/",
            "endorsementNotice": "This is an unofficial personal study dashboard and is not endorsed by MIT.",
        },
        "sourceFilesFound": {
            "courseMetadata": (ROOT / "data.json").as_posix(),
            "contentMap": (ROOT / "content_map.json").as_posix(),
            "pagesRoot": PAGES.as_posix(),
            "resourcesRoot": RESOURCES.as_posix(),
            "staticResourcesRoot": STATIC.as_posix(),
            "originalOfflineIndex": (ROOT / "index.html").as_posix(),
        },
        "counts": {
            "modules": len(modules),
            "lessons": len(lessons),
            "problemSets": len(problem_sets),
            "examPrepLessons": len(exams),
            "pdfResourcesLinked": len(
                {
                    item["filePath"]
                    for lesson in lessons
                    for bucket in lesson["resources"].values()
                    for item in bucket
                    if item.get("filePath")
                }
            ),
            "videoResourcesLinked": len(
                {
                    item["youtubeKey"]
                    for lesson in lessons
                    for item in lesson["resources"]["videos"]
                    if item.get("youtubeKey")
                }
            ),
        },
        "modules": modules,
        "studyPath": build_study_path(lessons),
        "weeklyPlan": build_weekly_plan(lessons),
    }


def main() -> None:
    course_map = build_map()
    json_text = json.dumps(course_map, indent=2, ensure_ascii=True)
    Path("course-map.json").write_text(json_text + "\n", encoding="utf-8")
    Path("site-data.js").write_text("window.COURSE_MAP = " + json_text + ";\n", encoding="utf-8")


if __name__ == "__main__":
    main()
