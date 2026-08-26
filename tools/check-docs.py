#!/usr/bin/env python3
"""Fails if the card grew an option the README does not mention.

Documentation goes stale the way it always does: the option is added, the
README is updated next time, and next time never comes. Three labels had
already slipped through by the time anyone looked. So the check runs in CI,
against the source rather than against a list kept by hand — a new key in
DEFAULTS or DEFAULT_LABELS has to appear in README.md or the build says so.

It is a coarse check on purpose: it looks for the name of each option
somewhere in the README, not for a good explanation of it. It cannot tell
whether what is written is any use; it can tell that nothing was written.

    python3 tools/check-docs.py
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
js = (ROOT / "nearby-card.js").read_text()
readme = (ROOT / "README.md").read_text()


def keys_of(block, indent):
    """The keys of a `const <block> = { ... }` literal, at one nesting level."""
    m = re.search(r"const " + block + r" = \{(.*?)\n  \};", js, re.S)
    if not m:
        sys.exit(f"check-docs: cannot find {block} in nearby-card.js")
    return re.findall(r"^ {%d}(\w+):" % indent, m.group(1), re.M)


wanted = []
wanted += [("", k) for k in keys_of("DEFAULTS", 4) if k != "presence"]
wanted += [("labels.", k) for k in keys_of("DEFAULT_LABELS", 4)]

m = re.search(r"presence: \{(.*?)\n    \},", js, re.S)
wanted += [("presence.", k) for k in re.findall(r"^ {6}(\w+):", m.group(1), re.M)]

# the area_sensor fields live in a comment, being a free-form object
wanted += [("presence.area_sensor.", k) for k in
           ("entity", "area_attribute", "floor_attribute", "distance_entity", "max_distance")]

# things that are not config keys but are part of the contract
wanted += [("", "nearby_area")]

# Whole words only. Plain substring matching would take `ex_group_icons` as
# proof that `group_icons` is documented, which is how a check quietly stops
# checking.
missing = [prefix + k for prefix, k in wanted
           if not re.search(r"(?<![\w-])" + re.escape(k) + r"(?![\w-])", readme)]

if missing:
    print("check-docs: these are configurable but never mentioned in README.md:")
    for name in missing:
        print("  -", name)
    sys.exit(1)

print(f"check-docs: {len(wanted)} options, all mentioned in README.md")
