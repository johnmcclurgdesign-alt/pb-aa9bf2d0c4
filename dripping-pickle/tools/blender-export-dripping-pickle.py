# Export the warehouse Structure collection from DP_Factory_Warehouse_Production.blend.
# Run INSIDE Blender (execute_blender_code exec()s this file, or paste into the Text editor).
#
#   The wall mural is a LIVE node mix (brick x painted sign x MuralFade) so the artist can
#   dial the fade in Blender — but glTF carries exactly one base-colour image per material,
#   so the mix must be FLATTENED before every export and the live graph restored after.
#   This script is that ritual. Do not export the scene by hand or the mural wall ships
#   with whichever single image the exporter happens to pick.
#
# After this, finish the pipeline outside Blender. The --set values come from
# assets/dripping-pickle/export-factors.json, which THIS script writes (windows tint +
# any Bright/Contrast dials folded into baseColorFactor) — read it, don't hardcode:
#   node tools/glb-webp.mjs assets/dripping-pickle/structure.glb assets/dripping-pickle/structure.webp.glb \
#        --quality 85 --max 1024
#   node tools/glb-basecolor.mjs assets/dripping-pickle/structure.webp.glb assets/dripping-pickle/structure.factored.glb \
#        --set "<name>=<r>,<g>,<b>" ... (one per entry in export-factors.json)
#   npx @gltf-transform/cli draco assets/dripping-pickle/structure.factored.glb assets/dripping-pickle/structure.glb
#   rm assets/dripping-pickle/structure.webp.glb assets/dripping-pickle/structure.factored.glb
#
# ★ `--max 1024` AND THE DRACO PASS ARE NOT OPTIONAL — THIS HEADER USED TO OMIT BOTH.
#   Following it literally rebuilds the building at 46.4 MB against the 8.98 MB that ships:
#   the source carries eight 4K and twenty-four 2K textures, and the shipped file is 34x1024
#   plus four odd sizes. Nothing errors — you just quintuple the page weight. Check the
#   result against ~9 MB before committing, and note baseColorFactor DOES survive Draco
#   (verified), so the patch may go before the compress.

import bpy, numpy as np, os, json

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

# ★ ONE constant, and it is ASSERTED. The loop was renamed warehouse -> dripping-pickle and
#   these four paths were not, so every export wrote into assets/warehouse/ — a directory that
#   does not exist — while the loop went on loading the old assets/dripping-pickle/ files. The
#   export reported success each time. os.makedirs would have HIDDEN it by creating the dead
#   folder, so the guard is an existence check, not a mkdir.
ASSETS = os.path.join(REPO, "assets", "dripping-pickle")
assert os.path.isdir(ASSETS), (
    "asset dir missing: %s — if the loop was renamed, update ASSETS here" % ASSETS)

OUT = os.path.join(ASSETS, "structure.glb")
MURAL_PNG = os.path.join(ASSETS, "brick_mural_wall.png")
FACTORS_JSON = os.path.join(ASSETS, "export-factors.json")

# ── materials whose Base Color is a GRADE, not a texture ────────────────────
#    material name -> tile written into assets/dripping-pickle/. See §1b.
#    EMPTY IS THE CORRECT STATE RIGHT NOW, and the machinery below is kept on purpose.
#    The roof used to be `wood_planks_dirt_60` — warm wood dialled to weathered grey through a
#    Hue/Sat + Bright/Contrast + curve chain — and shipped brown because glTF dropped the grade.
#    It was re-authored as a plain concrete material (2026-08-19), so nothing needs baking today.
#    `Frame.002` on the vintage refrigerator is still in this class over in the props pipeline.
GRADED_TILES = {
}

# ── 0. collect base-colour factors the exporter will drop ───────────────────
#    A Brightness/Contrast node in front of a Base Color texture vanishes on
#    export. Cycles' formula is out = (1+contrast)*c + (brightness-contrast/2),
#    linear — when the constant term is ~0 that is a pure multiply, which IS
#    glTF's baseColorFactor. Written to export-factors.json; glb-basecolor.mjs
#    applies them after glb-webp (see the pipeline in the header).
#
#    ★ WIDENED PAST BRIGHT/CONTRAST — issue #81. The old sweep only inspected
#    materials whose Base Color linked DIRECTLY from a BRIGHTCONTRAST node, so
#    `Wood_60`'s RGB Curves link was invisible to it and shipped un-graded
#    across 15 Structure objects while the sweep reported clean. That is the
#    same failure shape the repo CLAUDE.md records for the roof, with a
#    detector that misses it — "a partial detector is worse than none", since
#    a green run reads as "no dropped grades" when it means "no dropped
#    grades of the one kind I looked for". Walk the WHOLE chain between Base
#    Color and the source texture and warn on every node that is not a pure
#    multiply: RGB Curves, Hue/Saturation, a Mix that isn't Multiply-at-1.0,
#    a Bright/Contrast with a non-zero offset, a node group, anything else.
#    Only a single zero-offset Bright/Contrast sitting directly on Base Color
#    is folded into baseColorFactor — the same case the old sweep handled.
MANUALLY_FACTORED = {"modular_factory_facade_windows_60"}   # Mix-node tint, solved by hand below
factors = {"modular_factory_facade_windows_60": [0.0575, 0.0857, 0.045]}
PASS_THROUGH = {'REROUTE'}       # transparent — keep walking through these without a warning
MAX_CHAIN = 12                   # guard against an unexpectedly deep or cyclic graph

def _next_color_link(n):
    for name in ('Color', 'Color1', 'A', 'Color2', 'B'):
        inp = n.inputs.get(name)
        if inp and inp.links:
            return inp.links[0]
    return None

for mat in bpy.data.materials:
    if not mat.use_nodes or mat.name in MANUALLY_FACTORED: continue
    b = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not b or not b.inputs['Base Color'].links: continue
    link = b.inputs['Base Color'].links[0]
    hops = 0
    while link.from_node.type not in ('TEX_IMAGE', 'TEX_ENVIRONMENT'):
        n = link.from_node
        hops += 1
        if hops > MAX_CHAIN:
            print(f"WARNING: {mat.name} Base Color chain exceeds {MAX_CHAIN} nodes without "
                  f"reaching a texture — verify by hand, possible cycle at '{n.name}'.")
            break
        if n.type == 'BRIGHTCONTRAST':
            a = 1 + n.inputs['Contrast'].default_value
            off = n.inputs['Bright'].default_value - n.inputs['Contrast'].default_value / 2
            if abs(off) < 0.005 and hops == 1:
                factors[mat.name] = [round(a, 4)] * 3
                print(f"FACTOR: {mat.name} -> multiply {a:.3f} (Bright/Contrast folded into baseColorFactor)")
            else:
                print(f"WARNING: {mat.name} Bright/Contrast (node '{n.name}') has offset {off:+.3f} "
                      f"— NOT a pure multiply, ships un-graded unless baked. Add to GRADED_TILES.")
        elif n.type in PASS_THROUGH:
            pass
        else:
            print(f"WARNING: {mat.name} Base Color chain includes '{n.name}' ({n.type}) "
                  f"— not a pure multiply, ships un-graded unless baked. Add to GRADED_TILES.")
        nxt = _next_color_link(n)
        if not nxt:
            print(f"WARNING: {mat.name} Base Color chain ends at '{n.name}' ({n.type}) "
                  f"with no traceable source texture — verify by hand.")
            break
        link = nxt
with open(FACTORS_JSON, 'w') as f:
    json.dump(factors, f, indent=1)


# ── 1b. bake graded Base Color chains down to one tile ──────────────────────
#    A Hue/Sat + Brightness/Contrast + RGB Curves grade in front of Base Color is NOT a
#    pure multiply, so it cannot ship as baseColorFactor the way the sweep above ships a
#    Bright/Contrast dial — glTF exports the raw source texture and the whole grade is
#    silently thrown away. The roof was shipping warm brown planks while Blender showed
#    weathered grey (Saturation 0.0, Value 0.5, Bright -0.1 / Contrast -0.3, curve lift).
#
#    ★ BAKE IN IMAGE SPACE, NOT UV SPACE. The grade is a per-pixel function of ONE source
#    image, so baking the 0..1 tile through the same nodes keeps the texture TILING. A
#    UV-space bake would flatten the whole roof into an atlas and destroy the repeat.
#
#    ★ ZERO THE MAPPING NODE'S OFFSET FIRST. The exporter writes that offset as
#    KHR_texture_transform, so a tile baked with the offset already in it is shifted twice.
#
#    ★ THE BAKE TARGET MUST BE ACTIVE *AND* SELECTED — and this material already carries an
#    inert lightmap node literally named BAKE_TARGET, which would both win the name and be
#    picked as the target. It is removed from the copy first.
def bake_graded_tile(mat_name, out_path, res=2048):
    prev_scene = bpy.context.window.scene
    sc = bpy.data.scenes.new('__GRADE_BAKE__')
    bpy.context.window.scene = sc
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = 1
    sc.cycles.device = 'CPU'
    sc.cycles.bake_type = 'EMIT'
    sc.render.bake.use_clear = True
    sc.render.bake.margin = 0            # a margin would bleed across the tile's wrap edges
    sc.render.bake.use_selected_to_active = False
    try:
        bpy.ops.mesh.primitive_plane_add(size=2, location=(0, 0, 0))
        plane = bpy.context.active_object; plane.name = '__grade_plane__'

        m = bpy.data.materials[mat_name].copy(); m.name = '__grade_mat__'
        nt = m.node_tree
        bsdf_g = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
        chain = bsdf_g.inputs['Base Color'].links[0].from_node
        out_n = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
        old_bt = nt.nodes.get('BAKE_TARGET')
        if old_bt: nt.nodes.remove(old_bt)
        mp = nt.nodes.get('Mapping')
        if mp: mp.inputs['Location'].default_value = (0, 0, 0)

        em = nt.nodes.new('ShaderNodeEmission')
        nt.links.new(chain.outputs['Color'], em.inputs['Color'])
        nt.links.new(em.outputs['Emission'], out_n.inputs['Surface'])

        img = bpy.data.images.new('__grade_baked__', res, res, alpha=False, float_buffer=True)
        img.colorspace_settings.name = 'Non-Color'
        tgt = nt.nodes.new('ShaderNodeTexImage'); tgt.image = img; tgt.name = 'BAKE_TARGET'
        for n in nt.nodes: n.select = False
        tgt.select = True; nt.nodes.active = tgt
        assert tgt.select and nt.nodes.active.name == 'BAKE_TARGET', nt.nodes.active.name

        plane.data.materials.clear(); plane.data.materials.append(m)
        bpy.ops.object.select_all(action='DESELECT')
        plane.select_set(True); bpy.context.view_layer.objects.active = plane
        bpy.ops.object.bake(type='EMIT')

        buf = np.empty(res * res * 4, dtype=np.float32)
        img.pixels.foreach_get(buf)
        lin = np.clip(buf.reshape(-1, 4)[:, :3], 0.0, 1.0)
        # The bake is scene-linear; a byte PNG tagged sRGB stores sRGB-ENCODED values, and
        # that is exactly what image.pixels round-trips for a byte image (measured).
        srgb = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1 / 2.4) - 0.055)
        flat4 = np.ones((res * res, 4), dtype=np.float32)
        flat4[:, :3] = srgb
    finally:
        for nm, coll in (('__grade_plane__', bpy.data.objects), ('__grade_mat__', bpy.data.materials),
                         ('__grade_baked__', bpy.data.images)):
            o = coll.get(nm)
            if o: coll.remove(o)
        bpy.context.window.scene = prev_scene
        bpy.data.scenes.remove(sc)

    tile = bpy.data.images.get(os.path.basename(out_path))
    if tile: bpy.data.images.remove(tile)
    tile = bpy.data.images.new(os.path.basename(out_path), res, res, alpha=False)
    tile.colorspace_settings.name = 'sRGB'
    tile.pixels.foreach_set(flat4.ravel())
    tile.file_format = 'PNG'                 # ★ save() uses the DATABLOCK's format, not the extension
    tile.filepath_raw = out_path
    tile.save()
    tile.source = 'FILE'; tile.filepath = out_path
    print(f"BAKED GRADE: {mat_name} -> {out_path} "
          f"(sRGB mean {srgb.mean(axis=0).round(4)}, {os.path.getsize(out_path)/1e6:.1f} MB)")
    return tile


# ── 1. flatten the mural mix at the current MuralFade ───────────────────────
mural = bpy.data.materials['M_Brick_Mural_60']
mnt = mural.node_tree
fade = mnt.nodes['MuralFade'].outputs[0].default_value
W = bpy.data.images['Mural_BASE'].size[0]

def px(name):
    buf = np.empty(W * W * 4, dtype=np.float32)
    bpy.data.images[name].pixels.foreach_get(buf)
    return buf

base, col, alp = px('Mural_BASE'), px('Mural_COL'), px('Mural_ALP')
a = alp[0::4] * fade
out = base.copy()
for ch in range(3):
    out[ch::4] = base[ch::4] * (1 - a) + col[ch::4] * a
out[3::4] = 1.0

flat = bpy.data.images.get('MuralWall_60')
if flat: bpy.data.images.remove(flat)
flat = bpy.data.images.new('MuralWall_60', W, W, alpha=True)
flat.colorspace_settings.name = 'sRGB'
flat.pixels.foreach_set(out)
flat.alpha_mode = 'STRAIGHT'
flat.file_format = 'PNG'
flat.filepath_raw = MURAL_PNG
flat.save()
flat.source = 'FILE'; flat.filepath = MURAL_PNG
print(f"FLATTENED mural at fade {fade:.2f} -> {MURAL_PNG}")

# ── 2. temp-swap: flattened image straight into Base Color ──────────────────
bsdf = next(n for n in mnt.nodes if n.type == 'BSDF_PRINCIPLED')
mix_out = bsdf.inputs['Base Color'].links[0].from_socket   # remember the live mix
uvn = next(n for n in mnt.nodes if n.type == 'UVMAP')
exp = mnt.nodes.get('MURAL_EXPORT') or mnt.nodes.new('ShaderNodeTexImage')
exp.name = 'MURAL_EXPORT'; exp.label = 'flattened for export'
exp.image = flat
mnt.links.new(uvn.outputs['UV'], exp.inputs['Vector'])
for l in list(bsdf.inputs['Base Color'].links): mnt.links.remove(l)
mnt.links.new(exp.outputs['Color'], bsdf.inputs['Base Color'])

# ── 2b. temp-swap: baked grade tiles straight into Base Color ───────────────
#    The baked tile feeds through the material's EXISTING Mapping/Reroute vector, so the
#    exporter still writes the same KHR_texture_transform offset it always did — the tile
#    is the un-offset 0..1 repeat and the offset stays where it belongs, in the glTF.
graded_restore = []                      # (node_tree, bsdf, original from_socket)
for mat_name, fname in GRADED_TILES.items():
    gm = bpy.data.materials[mat_name]
    gnt = gm.node_tree
    gb = next(n for n in gnt.nodes if n.type == 'BSDF_PRINCIPLED')
    live = gb.inputs['Base Color'].links[0].from_socket
    tile = bake_graded_tile(mat_name, os.path.join(ASSETS, fname))
    gexp = gnt.nodes.get('GRADE_EXPORT') or gnt.nodes.new('ShaderNodeTexImage')
    gexp.name = 'GRADE_EXPORT'; gexp.label = 'baked grade for export'
    gexp.image = tile
    vec = next((n for n in gnt.nodes if n.type == 'MAPPING'), None)
    if vec: gnt.links.new(vec.outputs['Vector'], gexp.inputs['Vector'])
    for l in list(gb.inputs['Base Color'].links): gnt.links.remove(l)
    gnt.links.new(gexp.outputs['Color'], gb.inputs['Base Color'])
    graded_restore.append((gnt, gb, live))
    print(f"SWAPPED: {mat_name} Base Color -> baked tile")

try:
    # ── 3. export visible Structure meshes + the camera ─────────────────────
    struct = bpy.data.collections['Structure']
    def all_objs(col):
        out = list(col.objects)
        for c in col.children: out += all_objs(c)
        return out
    # The sign quad is a BAKE SOURCE, never an export target — excluded by NAME,
    # not just visibility, because an artist un-hiding it to look at it (2026-08-19)
    # shipped it as an opaque black-backed rectangle floating over the mural wall.
    BAKE_SOURCES = {'Sign_DrippingPickle.002'}
    targets = [o for o in all_objs(struct)
               if o.type == 'MESH' and not o.hide_get() and o.name not in BAKE_SOURCES]
    bpy.ops.object.select_all(action='DESELECT')
    for o in targets: o.select_set(True)
    bpy.data.objects['Camera'].select_set(True)
    bpy.context.view_layer.objects.active = targets[0]
    bpy.ops.export_scene.gltf(
        filepath=OUT, export_format='GLB', use_selection=True,
        export_apply=True, export_image_format='AUTO',
        export_cameras=True, export_animations=False,
    )
    print(f"EXPORTED: {OUT} {os.path.getsize(OUT)/1e6:.1f} MB ({len(targets)} meshes)")
finally:
    # ── 4. restore the live mix, whatever happened ───────────────────────────
    for l in list(bsdf.inputs['Base Color'].links): mnt.links.remove(l)
    mnt.links.new(mix_out, bsdf.inputs['Base Color'])
    print("RESTORED: live mural mix on Base Color")
    for gnt, gb, live in graded_restore:
        for l in list(gb.inputs['Base Color'].links): gnt.links.remove(l)
        gnt.links.new(live, gb.inputs['Base Color'])
    print(f"RESTORED: live grade chains on {len(graded_restore)} material(s)")
