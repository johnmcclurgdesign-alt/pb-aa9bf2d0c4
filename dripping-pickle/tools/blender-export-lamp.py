# ART2 (#75) — export the floor lamp to assets/dripping-pickle/props_lamp.glb.
# Run INSIDE Blender, headless, AFTER tools/blender-build-floor-lamp.py and blender-seat-props.py:
#   blender -b <production>.blend -P tools/blender-build-floor-lamp.py \
#       -P tools/blender-seat-props.py -P tools/blender-export-lamp.py \
#       --python-expr "import bpy; bpy.ops.wm.save_mainfile()"
#   (DP_LAMP_NOSAVE=1 on the build, so the ONE save at the end carries the build AND the seat)
#
# ★ THE LAMP SHIPS IN ITS OWN GLB, AS IT ALWAYS HAS (docs/lessons/props-ship-as-their-own-glb).
#   Before ART2 there was no script for this file at all: props_lamp.glb was exported by hand on
#   2026-08-19 from an object in the SCENE ROOT, which is how it escaped the props exporter, the
#   2026-08-24 audit and the provenance check for six weeks (docs/lessons/the-scene-root-trap-
#   hid-an-object). This exporter reads ONE named collection, `Props_Lamp`, and refuses to write
#   anything that is not a Prop_* the provenance CSV can key on.
#
# No conditioning step follows: the lamp has no image textures, so tools/condition-glb.sh has
# nothing to cook, and geometry ships uncompressed (no Draco — the Apple TV binding cannot
# decode it). The whole recipe is this file.
import bpy, os, json

REPO = os.environ.get("DP_REPO") or os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, "assets", "dripping-pickle", "props_lamp.glb")
COLL = "Props_Lamp"


def _log(*a):
    print("[export-lamp]", *a)


def run():
    coll = bpy.data.collections.get(COLL)
    assert coll, "no %s collection — run tools/blender-build-floor-lamp.py first" % COLL
    objs = [o for o in coll.all_objects if o.type == 'MESH' and not o.hide_render]
    assert objs, "nothing to export in %s" % COLL
    bad = [o.name for o in objs if not o.name.startswith("Prop_")]
    assert not bad, "not a Prop_* name, so budget-check's provenance scan cannot see it: %s" % bad
    # ⚠ `use_selection` reads VIEW-LAYER visibility, not hide_render (docs/lessons/use-visible-
    #   reads-view-layer-visibility). The retired lamp is hidden both ways; select explicitly.
    old = bpy.data.objects.get("Prop_Vintage_Floor_Lamp")
    assert old is None or old.hide_render, "the retired lamp is renderable again — it would not ship here, but say why"
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(
        filepath=OUT,
        export_format='GLB',
        use_selection=True,
        export_apply=True,
        export_image_format='AUTO',
        export_yup=True,
        export_cameras=False,
        export_lights=False,
        export_extras=False,
    )
    # read back what was WRITTEN, not what was asked for
    import struct
    b = open(OUT, 'rb').read()
    off, j = 12, None
    while off < len(b):
        ln, t = struct.unpack_from('<II', b, off)
        if t == 0x4E4F534A:
            j = json.loads(b[off + 8: off + 8 + ln])
        off += 8 + ln
    mats = [m["name"] for m in j.get("materials", [])]
    assert "glas" in mats, "no material named 'glas' — lightLamp() would not find the shade: %s" % mats
    assert not j.get("images"), "the lamp is meant to carry no textures: %d image(s)" % len(j["images"])
    assert not set(j.get("extensionsUsed", [])) & {"KHR_materials_transmission", "KHR_draco_mesh_compression"}, \
        j.get("extensionsUsed")
    nodes = [n.get("name") for n in j["nodes"]]
    return {"exported": OUT, "bytes": os.path.getsize(OUT), "nodes": nodes, "materials": mats,
            "primitives": sum(len(m["primitives"]) for m in j["meshes"]),
            "extensions": j.get("extensionsUsed", [])}


result = run()
_log(result)
