# Export the Props collection from DP_Factory_Warehouse_Production.blend to props.glb.
# Run INSIDE Blender (execute_blender_code exec()s this file, or paste into the Text editor).
#
#   There was no props exporter in tools/ until 2026-08-24 — props.glb had been produced
#   ad hoc, so a prop swap could not be shipped without re-deriving the whole recipe. This
#   is that recipe, from the rules in CLAUDE.md.
#
# After this, finish outside Blender:
#   cp assets/dripping-pickle/props.glb /tmp/props-raw.glb
#   tools/condition-glb.sh /tmp/props-raw.glb assets/dripping-pickle/props.glb 768
# ★ NO --keep-material SINCE TV1 (2026-10-06). Until then the chalkboard drew its photo into a 2D
#   canvas, so "Blackboard Chalkboard texture" had to stay an uncompressed PNG or the room stopped
#   at "setting the props". The chalk is GL now and the photo is never read, so the board cooks
#   with the other 140 (docs/lessons/the-props-cook-keeps-one-material-uncompressed.md, superseded).
# ⚠ THAT RECIPE CHANGED AT BUD1 (2026-09-10). It used to be glb-webp --max 768 then Draco.
#   With tvOS a shipping target, the Apple TV binding has no WebAssembly, so Basis/ETC1S is
#   refused by name and Draco is impossible; the cook is KTX2 / ASTC 6x6 with
#   supercompressionScheme 0 and uncompressed geometry. condition-glb.sh implements it.
# Then re-bake the GI (?gibake=1 in the loop, then window.__rt.saveGI()) — the props are the
# occluders and the shipped volume is baked against whatever set was in the room.

import bpy, os, json

# ★ THE REPO PATH IS RESOLVED, NOT TYPED — IT USED TO BE John's DESKTOP, HARDCODED.
#   `C:\Users\dexte\Desktop\...` ran on exactly one machine, and on any other the assert
#   below fires before a single object is touched. That is the good case; the bad one is a
#   path that happens to EXIST and is the wrong repo, which exports silently into nowhere
#   anyone is looking (this file already carries that scar — see the ASSETS assert).
#   Order: an explicit override wins, then the checkout this script is being run from.
#   Blender's exec() does not always define __file__, so both routes are guarded.
def _resolve_repo():
    env = os.environ.get("DP_REPO")
    if env:
        return env
    try:
        here = os.path.dirname(os.path.abspath(__file__))       # <repo>/tools
        return os.path.dirname(here)
    except NameError:
        pass
    for t in bpy.data.texts:                                     # pasted into the Text editor
        if t.filepath and t.name.startswith("blender-export"):
            return os.path.dirname(os.path.dirname(bpy.path.abspath(t.filepath)))
    raise RuntimeError(
        "cannot locate the repo. Run this file from <repo>/tools/, or set DP_REPO:\n"
        "  import os; os.environ['DP_REPO'] = '/path/to/loop-dripping-pickle-webgl-v1'")

REPO = _resolve_repo()
OUT  = os.path.join(REPO, "assets", "dripping-pickle", "props.glb")
TAG  = "__EXPORT_DECIMATE__"          # ours, and only ours, gets removed afterwards

# ★ PROPS THE CAMERA CANNOT SEE FROM EITHER POSE — MEASURED, NOT GUESSED (BUD1, 2026-09-10).
#   `hide_render` below is the artist's switch. This list is the BUDGET's, and it is separate
#   on purpose: it is a claim about the two declared camera poses, so it belongs in the repo
#   where the measurement that justifies it can be re-run, not inside a 2.9 GB .blend where
#   nobody can review it. The .blend keeps every one of these — dropping is an export decision.
#
#   How they were found, and how to re-find them after a re-dress: render an ID pass (a unique
#   flat colour per mesh) at the ROOM and SCREEN poses with the movers hidden, and count the
#   pixels each mesh paints. Then CONFIRM each candidate by hiding it and differencing the lit
#   frame INCLUDING shadows — a prop that paints nothing can still cast something you can see,
#   and a bounding box says nothing about either. Both controls must pass first: hiding a prop
#   that IS in the picture must move thousands of pixels, and changing nothing must move zero.
#   (A composited-frame grab through `__looks.render()` does NOT re-render — it composites a
#   cached beauty target and reports zero difference for everything, which is what the
#   "change nothing" control is there to catch. Render the scene to your own target instead.)
#
#   Measured at 1280x720: all five paint 0 px at both poses and move 0 px when removed.
#   Together they are 84.8 MB resident and 65,908 triangles — 11% of the whole texture budget
#   on things no viewer has ever seen. 20 more props also paint nothing but carry no texture
#   at all; they are left in deliberately (Prop_Desk_Centre and Prop_Camera_Monitor are canon's
#   unseen workstation, and the rest are 5,106 triangles that BUD2 can weigh against shadows).
DROP_UNSEEN = {
    "Prop_Sofa",                      # 48.0 MB, 38,986 tri — behind the desk and Column022
    "Prop_Vintage_Refrigerator.001",  # 18.0 MB, 15,692 tri — also the known bad Bright/Contrast export (Frame.002)
    "Prop_Cardboard_Box",             #  9.0 MB,  5,380 tri
    "Prop_Portable_Searchlight",      #  5.3 MB,  5,222 tri
    "Prop_Cardboard_Box_SQ01",        #  4.5 MB,    628 tri
}

def _chain(obj):
    """The object and every ancestor, so a DROP_UNSEEN name can be checked against parents too."""
    n = obj
    while n is not None:
        yield n
        n = n.parent


def _dropped(obj):
    """True if this object or any ancestor is on the unseen list (children ride with the parent)."""
    n = obj
    while n is not None:
        if n.name in DROP_UNSEEN:
            return True
        n = n.parent
    return False

# ★ BUDGET BY SCREEN SIZE, NOT A FLAT RATIO. The set arrived at 2.9M triangles — 7.5x the
#   whole building — with a 0.11 m paint can at 50,000 and a flat rug at 631,556. Budget
#   scales with the object's diagonal so the sofa keeps its silhouette and the can starves.
def budget_for(diagonal_m):
    return min(45000, max(600, diagonal_m * 14000))

def tri_count(obj, dg):
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    try:
        me.calc_loop_triangles()
        return len(me.loop_triangles)
    finally:
        ev.to_mesh_clear()

def run():
    props = bpy.data.collections.get("Props")
    assert props, "no Props collection"
    dg = bpy.context.evaluated_depsgraph_get()
    # ★ hide_render EXCLUDES A PROP FROM THE PAYLOAD — this is how the DP-W1
    #   disposition list's "GO" items (surplus TVs, the paint kit, etc.) stay
    #   out of the Beta export while staying in the .blend for John's reference.
    #   Before this filter existed, EVERY mesh in Props shipped regardless of
    #   visibility, which silently resurrected props Gate A cut.
    all_meshes = [o for o in props.all_objects if o.type == 'MESH']
    meshes = [o for o in all_meshes if not o.hide_render and not _dropped(o)]
    excluded = [o.name for o in all_meshes if o.hide_render]
    dropped = [o.name for o in all_meshes if not o.hide_render and _dropped(o)]
    if excluded:
        print(f"EXCLUDED (hide_render): {len(excluded)} props -> {excluded}")
    if dropped:
        print(f"DROPPED (DROP_UNSEEN, measured 0 px at both poses): {len(dropped)} meshes -> {dropped}")
    # ⚠ A name that matches NOTHING is the failure this assert exists to catch: a re-dress that
    #   renames a prop would silently ship it again, and the only symptom is the budget creeping
    #   back up. Fail the export instead.
    missing = {n for n in DROP_UNSEEN if n not in {c.name for o in all_meshes for c in _chain(o)}}
    assert not missing, f"DROP_UNSEEN names nothing in the Props collection: {sorted(missing)}"

    # ── 1. add a decimate wherever the object is over its budget ─────────────
    added, report, before_total, after_total = [], [], 0, 0
    for o in meshes:
        d = o.dimensions
        diag = (d.x**2 + d.y**2 + d.z**2) ** 0.5
        tris = tri_count(o, dg)
        before_total += tris
        cap = budget_for(diag)
        if tris > cap:
            m = o.modifiers.new(TAG, 'DECIMATE')
            m.decimate_type = 'COLLAPSE'
            m.ratio = max(0.01, cap / tris)
            added.append((o, m.name))
            dg = bpy.context.evaluated_depsgraph_get()
            now = tri_count(o, dg)
        else:
            now = tris
        after_total += now
        report.append({"obj": o.name, "diag_m": round(diag, 3),
                       "tris_before": tris, "budget": int(cap), "tris_after": now})

    try:
        # ── 2. export ONLY the props, with every modifier applied ────────────
        bpy.ops.object.select_all(action='DESELECT')
        for o in meshes:
            o.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        bpy.ops.export_scene.gltf(
            filepath=OUT,
            export_format='GLB',
            use_selection=True,
            export_apply=True,              # bakes the decimate (and the artists' own modifiers)
            export_image_format='AUTO',     # pass source bytes through; glb-webp does the encode
            export_yup=True,
            export_cameras=False,
            export_lights=False,
            export_extras=False,
        )
    finally:
        # ── 3. ALWAYS put the blend back. Never decimate the source. ─────────
        failed = []
        for o, name in added:
            m = o.modifiers.get(name)
            if m:
                try: o.modifiers.remove(m)
                except Exception as e: failed.append((o.name, repr(e)))
            else:
                failed.append((o.name, "modifier vanished"))
        assert not failed, "DECIMATE NOT REMOVED: %s" % failed

    left = [o.name for o in meshes if any(m.name == TAG for m in o.modifiers)]
    return {
        "exported": OUT,
        "size_mb": round(os.path.getsize(OUT) / 1e6, 2),
        "objects": len(meshes),
        "excluded_hidden": len(excluded),
        "dropped_unseen": dropped,
        "tris_before": before_total,
        "tris_after": after_total,
        "ratio": round(after_total / before_total, 4) if before_total else None,
        "decimated_objects": len(added),
        "decimate_modifiers_left_behind": left,
        "top_10_by_tris": sorted(report, key=lambda r: -r["tris_before"])[:10],
    }

result = run()
