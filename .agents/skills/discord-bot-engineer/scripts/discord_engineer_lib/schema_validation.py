from __future__ import annotations

from pathlib import Path
from typing import Any

from .io_utils import load_json
from .manifest import SCHEMA_ROOT


TYPE_MAP = {
    "object": dict,
    "array": list,
    "string": str,
    "integer": int,
    "number": (int, float),
    "boolean": bool,
    "null": type(None),
}


def _matches_type(value: Any, expected: str) -> bool:
    if expected not in TYPE_MAP:
        return False
    if expected in {"integer", "number"} and isinstance(value, bool):
        return False
    return isinstance(value, TYPE_MAP[expected])


def validate_value(value: Any, schema: dict[str, Any], path: str = "$") -> list[str]:
    """Validate the deterministic subset of JSON Schema used by this Skill."""
    errors: list[str] = []
    expected = schema.get("type")
    if isinstance(expected, str) and not _matches_type(value, expected):
        return [f"{path}: expected {expected}, got {type(value).__name__}"]
    if isinstance(expected, list) and not any(isinstance(item, str) and _matches_type(value, item) for item in expected):
        return [f"{path}: expected one of {expected!r}, got {type(value).__name__}"]
    if "const" in schema and value != schema["const"]:
        errors.append(f"{path}: expected constant {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: value is not in {schema['enum']!r}")
    if isinstance(value, str) and len(value) < schema.get("minLength", 0):
        errors.append(f"{path}: string is shorter than minLength")
    if isinstance(value, str) and isinstance(schema.get("maxLength"), int) and len(value) > schema["maxLength"]:
        errors.append(f"{path}: string is longer than maxLength")
    if isinstance(value, str) and isinstance(schema.get("pattern"), str):
        import re
        if re.search(schema["pattern"], value) is None:
            errors.append(f"{path}: string does not match pattern")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}: number is less than minimum")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{path}: number is greater than maximum")
    if isinstance(value, dict):
        for name in schema.get("required", []):
            if name not in value:
                errors.append(f"{path}: missing required property {name}")
        properties = schema.get("properties", {})
        for name, child in properties.items():
            if name in value:
                errors.extend(validate_value(value[name], child, f"{path}.{name}"))
        if schema.get("additionalProperties") is False:
            for name in value.keys() - properties.keys():
                errors.append(f"{path}: unexpected property {name}")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            errors.append(f"{path}: array has fewer items than minItems")
        if isinstance(schema.get("maxItems"), int) and len(value) > schema["maxItems"]:
            errors.append(f"{path}: array has more items than maxItems")
        if isinstance(schema.get("items"), dict):
            for index, item in enumerate(value):
                errors.extend(validate_value(item, schema["items"], f"{path}[{index}]"))
    return errors


def validate_named(value: Any, schema_name: str) -> list[str]:
    path = SCHEMA_ROOT / schema_name
    if not path.is_file():
        return [f"unknown schema: {schema_name}"]
    schema = load_json(path)
    return validate_value(value, schema)


def available_schemas() -> list[str]:
    return sorted(path.name for path in Path(SCHEMA_ROOT).glob("*.schema.json"))
