# tools/blender-build-mouse.py — NPC-003. Builds "Caper", the Outpost mouse:
# mesh, armature, four clips, and the exported .glb. ORIGINAL ASSET.
#
# Run headless:
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
#       --python tools/blender-build-mouse.py
#
# WHY THIS IS A SCRIPT AND NOT A SCULPT (decision, Josh, 2026-09-06):
#   The mouse spans 0.85-1.03% of frame width at the ROOM pose — about 11-13 px
#   at 1280. A scripted form is reproducible, re-runnable when proportions move,
#   and it is what makes the `original` provenance row honest: this file IS the
#   asset's authorship. A sculpt pass can replace it later without the loop
#   noticing, because tools/mouse-routes.js only asks for a bone naming contract.
#
# ★ THE MOUSE IS AUTHORED FACING BLENDER -Y, AND THAT IS NOT AN AESTHETIC CHOICE.
#   glTF export maps Blender (x, y, z) -> (x, z, -y), so Blender -Y becomes
#   three's +Z. `measureAuthoredSpeed` in tools/cat-walk.js measures a planted
#   paw's backward sweep along +Z and finds its bones by /^claw_/. Authoring to
#   that convention means the foot-slide number is MEASURED for the mouse by the
#   same code that measures it for the cat, rather than a second implementation
#   drifting away from the first. Toe bones are therefore claw_FL/FR/BL/BR.
#
# ★ EVERY CLIP IS IN PLACE. No root translation anywhere, including `squeeze` —
#   the controller owns world position. This is the cat's _IP-not-_RM lesson:
#   root motion plus a steering system is double speed, and it reads as the feet
#   being wrong rather than as two movement systems fighting.
#
# ★ THE CRACK IS THE CONSTRAINT. corner-dressing.js opens 0.075 x 0.135 m at
#   world x 2.069, z 1.20. The squeeze pose is asserted through it below; a mouse
#   that does not fit its own doorway is invisible from 7 m and obvious on a
#   push-in.

import bpy, bmesh, math, os, sys, json
from mathutils import Vector, Euler

# ── where things go ────────────────────────────────────────────────────────
# REPO is resolved, never typed (repo CLAUDE.md: a hardcoded path that happens
# to exist and is the WRONG checkout exports silently into a dead directory).
def resolve_repo():
    env = os.environ.get('DP_REPO')
    if env and os.path.isdir(os.path.join(env, 'tools')):
        return env
    here = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else None
    if here:
        cand = os.path.dirname(here)
        if os.path.isdir(os.path.join(cand, 'tools')):
            return cand
    for t in bpy.data.texts:
        if t.filepath:
            cand = os.path.dirname(os.path.dirname(bpy.path.abspath(t.filepath)))
            if os.path.isdir(os.path.join(cand, 'tools')):
                return cand
    raise RuntimeError('cannot resolve DP_REPO')

REPO = resolve_repo()
ASSETS = os.path.join(REPO, 'assets', 'mouse')
assert os.path.isdir(ASSETS), f'missing {ASSETS}'
GLB_OUT = os.path.join(ASSETS, 'mouse.glb')
# The .blend is an intermediate and lives on the external drive with every other
# DP intermediate — the internal disk runs at ~99%.
BLEND_DIR = '/Volumes/family-data-josh/Code-Workspace/dripping-pickle-blend/work'
BLEND_OUT = os.path.join(BLEND_DIR, 'DP_Mouse.blend')

FPS = 60

# ── proportions, in metres, authored facing -Y ─────────────────────────────
# Nose at -Y, rump at +Y, up +Z, floor at z = 0.
BODY = [
    # (y, radius, z centre)  nose -> rump. A mouse is SLIM with a pointed snout
    # and a pinched neck; the first pass barrelled at 0.022 over 0.085 and read
    # as a guinea pig from every angle.
    (-0.0500, 0.0028, 0.0175),   # nose tip
    (-0.0450, 0.0060, 0.0185),
    (-0.0390, 0.0098, 0.0198),   # muzzle
    (-0.0310, 0.0132, 0.0215),   # cheek
    (-0.0230, 0.0128, 0.0220),   # skull
    (-0.0170, 0.0112, 0.0218),   # neck pinch — what separates head from body
    (-0.0080, 0.0150, 0.0225),   # shoulder
    ( 0.0060, 0.0175, 0.0230),   # barrel
    ( 0.0200, 0.0170, 0.0225),
    ( 0.0330, 0.0135, 0.0215),
    ( 0.0420, 0.0080, 0.0205),   # rump
]
BELLY_FLATTEN = 0.92      # a mouse is not a cylinder; the belly rides low
RING_SEGS = 12

# The tail STARTS INSIDE THE RUMP (y = 0.030, not 0.042). Butted exactly against
# the rump cap, subsurf shrinks both toward their own centres and opens a visible
# gap between body and tail.
TAIL = [(0.0300, 0.0048), (0.0480, 0.0030), (0.0680, 0.0022),
        (0.0880, 0.0015), (0.1080, 0.0010), (0.1220, 0.0007)]
TAIL_Z = [0.0212, 0.0208, 0.0220, 0.0214, 0.0190, 0.0158]

# ★ THE EAR IS A DISC WHOSE FACE POINTS OUTWARD, NOT A CONE POINTING SOMEWHERE.
#   The first pass rotated a cone 90 degrees about X, which sends its axis along
#   -Y — down the length of the body — so both ears rendered as a fin behind the
#   skull and subsurf smoothed them into lumps. EAR_DIR is the disc's normal.
EAR_R, EAR_Y, EAR_X, EAR_Z = 0.0072, -0.0248, 0.0062, 0.0298
EAR_DIR = (0.72, -0.12, 0.68)     # outward and UP — they sit on the skull,
#                                   not on the cheek, and at 0.0105 they were
#                                   nearly as wide as the head itself.
EYE_R, EYE_Y, EYE_X, EYE_Z = 0.0020, -0.0355, 0.0080, 0.0245
NOSE_R, NOSE_Y, NOSE_Z = 0.0016, -0.0505, 0.0175

# hips/shoulders: (name, y, x sign, hip z)
LEGS = [('FL', -0.0140,  1), ('FR', -0.0140, -1),
        ('BL',  0.0240,  1), ('BR',  0.0240, -1)]
LEG_X, HIP_Z, KNEE_Z, PAW_Z = 0.0100, 0.0165, 0.0085, 0.0015


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = FPS
    # ★ frame 0, not 1. The exporter maps frame f -> f/fps with no offset, so
    # keying from 1 puts the first key at t = 0.0167 and every `scurry` cycle
    # opens with a held frame the loop cannot see past.
    bpy.context.scene.frame_start = 0
    bpy.context.scene.unit_settings.system = 'METRIC'
    bpy.context.scene.unit_settings.scale_length = 1.0


# ── mesh ───────────────────────────────────────────────────────────────────
def ring(bm, y, r, zc, segs=RING_SEGS):
    vs = []
    for i in range(segs):
        a = 2 * math.pi * i / segs
        vs.append(bm.verts.new((r * math.cos(a), y,
                                zc + r * math.sin(a) * BELLY_FLATTEN)))
    return vs


def bridge(bm, a, b):
    n = len(a)
    for i in range(n):
        bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))


def tube(bm, pts, segs=8):
    """pts = [(y, r, z)] swept along -Y..+Y."""
    rings = [ring(bm, y, r, z, segs) for (y, r, z) in pts]
    for i in range(len(rings) - 1):
        bridge(bm, rings[i], rings[i + 1])
    return rings


def build_mesh():
    bm = bmesh.new()

    # body: a swept profile, capped at both ends
    rings = tube(bm, BODY)
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])

    # tail — its own tube, welded later by the subsurf/merge doing nothing
    # clever; it simply starts inside the rump so no seam is visible.
    tail_pts = [(TAIL[i][0], TAIL[i][1], TAIL_Z[i]) for i in range(len(TAIL))]
    trings = tube(bm, tail_pts, segs=6)
    bm.faces.new(list(reversed(trings[0])))
    bm.faces.new(trings[-1])

    bm.to_mesh(bpy.data.meshes.new('MouseBodyMesh'))
    me = bpy.data.meshes['MouseBodyMesh']
    bm.to_mesh(me)
    bm.free()

    body = bpy.data.objects.new('Mouse_Body', me)
    bpy.context.collection.objects.link(body)

    # ears — thin cones, splayed outward. Two objects joined in, because a
    # swept profile cannot make them and they are what read as "mouse" first.
    ears = []
    for sx in (1, -1):
        bpy.ops.mesh.primitive_cylinder_add(vertices=14, radius=EAR_R, depth=0.0028,
                                            location=(sx * EAR_X, EAR_Y, EAR_Z))
        e = bpy.context.object
        e.name = f'Mouse_Ear_{"L" if sx > 0 else "R"}'
        # a cylinder's axis is +Z; aim that axis along EAR_DIR so the flat face
        # is the ear's face. to_track_quat, not a typed Euler — the typed one is
        # exactly what pointed them down the body.
        d = Vector((sx * EAR_DIR[0], EAR_DIR[1], EAR_DIR[2])).normalized()
        e.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
        e.scale = (1.0, 1.12, 1.0)      # slightly taller than wide
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        ears.append(e)

    # legs — tapered tubes from hip to paw
    legs = []
    for (name, ly, sx) in LEGS:
        bmL = bmesh.new()
        pts = [(0.0, 0.0042, 0.0), (0.0, 0.0034, 0.0), (0.0, 0.0026, 0.0)]
        zs = [HIP_Z, KNEE_Z, PAW_Z]
        rings = []
        for i, (_, r, _) in enumerate(pts):
            vs = []
            for k in range(6):
                a = 2 * math.pi * k / 6
                vs.append(bmL.verts.new((r * math.cos(a) + sx * LEG_X,
                                         ly + r * math.sin(a),
                                         zs[i])))
            rings.append(vs)
        for i in range(len(rings) - 1):
            bridge(bmL, rings[i], rings[i + 1])
        bmL.faces.new(list(reversed(rings[0])))
        bmL.faces.new(rings[-1])
        meL = bpy.data.meshes.new(f'MouseLeg_{name}')
        bmL.to_mesh(meL); bmL.free()
        ob = bpy.data.objects.new(f'Mouse_Leg_{name}', meL)
        bpy.context.collection.objects.link(ob)
        legs.append(ob)

    # join everything that shares the fur material
    bpy.ops.object.select_all(action='DESELECT')
    for o in [body] + ears + legs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    body = bpy.context.object
    body.name = 'Mouse'
    body.data.name = 'MouseMesh'

    # smooth + one subsurf level: the silhouette is the whole read at 13 px
    bpy.ops.object.shade_smooth()
    sub = body.modifiers.new('Subdivision', 'SUBSURF')
    sub.levels = 1
    sub.render_levels = 1

    # eyes and nose — separate object, separate (dark) material. Invisible in
    # the hero shot, and the only thing that makes the push-in frame read.
    bpy.ops.object.select_all(action='DESELECT')
    darks = []
    for (x, y, z, r) in [(EYE_X, EYE_Y, EYE_Z, EYE_R), (-EYE_X, EYE_Y, EYE_Z, EYE_R),
                         (0.0, NOSE_Y, NOSE_Z, NOSE_R)]:
        bpy.ops.mesh.primitive_uv_sphere_add(segments=8, ring_count=6, radius=r,
                                             location=(x, y, z))
        darks.append(bpy.context.object)
    bpy.ops.object.select_all(action='DESELECT')
    for o in darks:
        o.select_set(True)
    bpy.context.view_layer.objects.active = darks[0]
    bpy.ops.object.join()
    dark = bpy.context.object
    dark.name = 'Mouse_Features'
    bpy.ops.object.shade_smooth()

    return body, dark


def build_materials(body, dark):
    # ★ NO TEXTURE MAPS. At 13 px a 512 base colour is payload for nothing, and
    # it removes the externally-loaded-texture flipY/colorSpace trap entirely.
    fur = bpy.data.materials.new('Mouse_Fur')
    fur.use_nodes = True
    fur.use_backface_culling = True
    b = fur.node_tree.nodes['Principled BSDF']
    # ★ THESE ARE LINEAR, AND THAT IS A FACTOR OF THREE. Blender's Base Color and
    #   glTF's baseColorFactor are both linear, so the first pass's 0.128 is
    #   sRGB 0.39 — a MID grey. Rendered in the Outpost he came out the palest
    #   thing in frame, brighter than the floorboards, which is not a mouse.
    #   0.030 linear is sRGB ~0.19: a dark warm grey-brown that also gives the
    #   belt run the silhouette it depends on.
    b.inputs['Base Color'].default_value = (0.030, 0.026, 0.024, 1.0)
    b.inputs['Roughness'].default_value = 0.82
    b.inputs['Metallic'].default_value = 0.0
    body.data.materials.append(fur)

    wet = bpy.data.materials.new('Mouse_Features')
    wet.use_nodes = True
    wet.use_backface_culling = True
    b2 = wet.node_tree.nodes['Principled BSDF']
    b2.inputs['Base Color'].default_value = (0.008, 0.007, 0.007, 1.0)
    b2.inputs['Roughness'].default_value = 0.28
    dark.data.materials.append(wet)


# ── armature ───────────────────────────────────────────────────────────────
# 23 bones. Enough that the tail carries the motion, which at this size is the
# only articulation anyone actually reads.
BONES = [
    # name, head, tail, parent
    ('root',     (0, 0.030, 0.000), (0, 0.000, 0.000), None),
    ('spine_01', (0, 0.0420, 0.0205), (0, 0.0060, 0.0230), 'root'),
    ('spine_02', (0, 0.0060, 0.0230), (0, -0.0170, 0.0218), 'spine_01'),
    ('neck',     (0, -0.0170, 0.0218), (0, -0.0280, 0.0220), 'spine_02'),
    ('head',     (0, -0.0280, 0.0220), (0, -0.0500, 0.0175), 'neck'),
    ('ear_L',    ( 0.0060, -0.0295, 0.0250), ( 0.0135, -0.0320, 0.0322), 'head'),
    ('ear_R',    (-0.0060, -0.0295, 0.0250), (-0.0135, -0.0320, 0.0322), 'head'),
    ('tail_01',  (0, 0.0420, 0.0205), (0, 0.0620, 0.0220), 'spine_01'),
    ('tail_02',  (0, 0.0620, 0.0220), (0, 0.0820, 0.0218), 'tail_01'),
    ('tail_03',  (0, 0.0820, 0.0218), (0, 0.1000, 0.0196), 'tail_02'),
    ('tail_04',  (0, 0.1000, 0.0196), (0, 0.1170, 0.0162), 'tail_03'),
]
for (name, ly, sx) in LEGS:
    par = 'spine_02' if name[0] == 'F' else 'spine_01'
    BONES += [
        (f'leg_{name}_up', (sx * LEG_X, ly, HIP_Z), (sx * LEG_X, ly, KNEE_Z), par),
        (f'leg_{name}_lo', (sx * LEG_X, ly, KNEE_Z), (sx * LEG_X, ly, PAW_Z), f'leg_{name}_up'),
        # ★ claw_* is the CONTACT joint. measureAuthoredSpeed reads a bone's HEAD
        #   world position, so the head has to sit at the paw, not the ankle.
        (f'claw_{name}', (sx * LEG_X, ly, PAW_Z), (sx * LEG_X, ly - 0.0045, PAW_Z), f'leg_{name}_lo'),
    ]


def build_armature(body, dark):
    arm_data = bpy.data.armatures.new('MouseRig')
    arm = bpy.data.objects.new('Mouse_Rig', arm_data)
    bpy.context.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    made = {}
    for (name, h, t, par) in BONES:
        b = arm_data.edit_bones.new(name)
        b.head = Vector(h); b.tail = Vector(t)
        b.use_connect = False
        made[name] = b
    for (name, h, t, par) in BONES:
        if par:
            made[name].parent = made[par]
    bpy.ops.object.mode_set(mode='OBJECT')

    for ob in (body, dark):
        bpy.ops.object.select_all(action='DESELECT')
        ob.select_set(True)
        arm.select_set(True)
        bpy.context.view_layer.objects.active = arm
        bpy.ops.object.parent_set(type='ARMATURE_AUTO')

    # ★ AUTOMATIC WEIGHTS PRODUCE >4 INFLUENCES AND WEIGHTS OF 1.0000001, AND
    #   BOTH SURFACE AS EXPORTER WARNINGS THAT LOOK LIKE THE MESH IS BROKEN. The
    #   weight clamp clears the "Mesh is not valid" error; the >4-influences
    #   warning SURVIVES on purpose, because subsurf is applied at export and
    #   interpolates new influences after this runs. glTF keeps the top 4.
    #   glTF keeps the top 4 and normalises anyway, so doing it here makes the
    #   result deterministic AND leaves a clean export log — which matters,
    #   because the log is where a REAL warning has to be visible.
    for ob in (body, dark):
        bpy.ops.object.select_all(action='DESELECT')
        ob.select_set(True)
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.vertex_group_limit_total(limit=4)
        for v in ob.data.vertices:
            for g in v.groups:
                if g.weight > 1.0:
                    ob.vertex_groups[g.group].add([v.index], 1.0, 'REPLACE')
    return arm


# ── clips ──────────────────────────────────────────────────────────────────
def new_action(arm, name):
    if arm.animation_data is None:
        arm.animation_data_create()
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data.action = act
    # Blender 4.4+ slotted actions: assigning a fresh action leaves no slot, and
    # keyframe_insert on an unslotted action silently writes nowhere.
    try:
        if not act.slots:
            slot = act.slots.new(id_type='OBJECT', name='MouseRig')
            arm.animation_data.action_slot = slot
        else:
            arm.animation_data.action_slot = act.slots[0]
    except Exception:
        pass
    return act


def key(arm, bone, frame, rot=None, loc=None, scale=None):
    pb = arm.pose.bones[bone]
    pb.rotation_mode = 'XYZ'
    if rot is not None:
        pb.rotation_euler = Euler([math.radians(v) for v in rot], 'XYZ')
        pb.keyframe_insert('rotation_euler', frame=frame)
    if loc is not None:
        pb.location = Vector(loc)
        pb.keyframe_insert('location', frame=frame)
    if scale is not None:
        pb.scale = Vector(scale)
        pb.keyframe_insert('scale', frame=frame)


def clear_pose(arm):
    for pb in arm.pose.bones:
        pb.rotation_mode = 'XYZ'
        pb.rotation_euler = Euler((0, 0, 0), 'XYZ')
        pb.location = Vector((0, 0, 0))
        pb.scale = Vector((1, 1, 1))


LEG_PHASE = {'FL': 0.0, 'BR': 0.0, 'FR': 0.5, 'BL': 0.5}   # diagonal pairs


def clip_scurry(arm):
    """8 frames at 60 fps = 7.5 Hz step frequency. A mouse's legs are short, so
    the speed has to come from CADENCE, not from stride: at a 0.2 s cycle the
    authored speed lands under 0.2 m/s and reads as a stroll. The real number is
    MEASURED after export by measureAuthoredSpeed, never predicted here."""
    act = new_action(arm, 'scurry')
    clear_pose(arm)
    N = 8
    SWING = 34.0        # upper leg, degrees fore/aft
    KNEE = 26.0
    for f in range(N + 1):
        t = f / N
        for (name, _, _) in LEGS:
            ph = (t + LEG_PHASE[name]) % 1.0
            a = math.sin(2 * math.pi * ph)
            # knee folds on the recovery half only, so the stance stays straight
            fold = max(0.0, math.sin(2 * math.pi * ph + math.pi / 2))
            key(arm, f'leg_{name}_up', f, rot=(SWING * a, 0, 0))
            key(arm, f'leg_{name}_lo', f, rot=(-KNEE * fold, 0, 0))
            key(arm, f'claw_{name}', f, rot=(KNEE * 0.5 * fold, 0, 0))
        # body bob at twice leg frequency, and a spine flex that makes it a bound
        bob = math.sin(4 * math.pi * t)
        key(arm, 'root', f, loc=(0, 0, 0.0018 * bob))
        key(arm, 'spine_01', f, rot=(4.5 * bob, 0, 0))
        key(arm, 'spine_02', f, rot=(-3.0 * bob, 0, 0))
        # tail streams behind, one beat late
        for i, b in enumerate(['tail_01', 'tail_02', 'tail_03', 'tail_04']):
            lag = math.sin(2 * math.pi * (t - 0.12 * i))
            key(arm, b, f, rot=(-6 - 3 * lag, 0, 9 * lag))
    return act, 0, N


def clip_freeze(arm):
    """The hard stop. Canon's punctuation and what the tap-freeze interaction
    needs — so it is not a static pose: flanks breathe and one ear twitches."""
    act = new_action(arm, 'freeze')
    clear_pose(arm)
    N = 48                      # 0.8 s
    for f in range(N + 1):
        t = f / N
        br = math.sin(2 * math.pi * t)
        key(arm, 'root', f, loc=(0, 0, -0.0022))
        key(arm, 'spine_01', f, rot=(2.0 + 0.9 * br, 0, 0), scale=(1 + 0.02 * br, 1, 1))
        key(arm, 'spine_02', f, rot=(1.0 + 0.6 * br, 0, 0), scale=(1 + 0.02 * br, 1, 1))
        key(arm, 'neck', f, rot=(-6.0, 0, 0))
        key(arm, 'head', f, rot=(-4.0, 0, 0))
        for (name, _, _) in LEGS:
            key(arm, f'leg_{name}_up', f, rot=(10.0, 0, 0))
            key(arm, f'leg_{name}_lo', f, rot=(-14.0, 0, 0))
        for i, b in enumerate(['tail_01', 'tail_02', 'tail_03', 'tail_04']):
            key(arm, b, f, rot=(-4, 0, 2.5 * math.sin(2 * math.pi * (t - 0.15 * i))))
    # the twitch — a single ear, once, off the breathing beat
    for (fr, ang) in [(0, 0), (25, 0), (28, -16), (31, 3), (34, 0), (N, 0)]:
        key(arm, 'ear_L', fr, rot=(0, ang, 0))
    return act, 0, N


def clip_sniff(arm):
    """A rear-up head cast — the idle at a route waypoint. The front paws leave
    the floor, which is why this clip and `scurry` cannot share a stance."""
    act = new_action(arm, 'sniff')
    clear_pose(arm)
    N = 72                      # 1.2 s
    for f in range(N + 1):
        t = f / N
        rear = math.sin(math.pi * min(1.0, t / 0.85)) ** 0.6   # up, hold, down
        cast = math.sin(4 * math.pi * t) * rear
        twitch = math.sin(18 * math.pi * t) * rear
        key(arm, 'root', f, loc=(0, 0, 0.004 * rear), rot=(-26 * rear, 0, 0))
        key(arm, 'spine_01', f, rot=(-10 * rear, 0, 0))
        key(arm, 'spine_02', f, rot=(-8 * rear, 0, 0))
        key(arm, 'neck', f, rot=(-6 * rear, 0, 14 * cast))
        key(arm, 'head', f, rot=(-4 * rear + 1.5 * twitch, 0, 10 * cast))
        key(arm, 'ear_L', f, rot=(0, -6 * cast, 0))
        key(arm, 'ear_R', f, rot=(0, -6 * cast, 0))
        for (name, _, _) in LEGS:
            if name[0] == 'F':      # front paws tuck up under the chin
                key(arm, f'leg_{name}_up', f, rot=(-52 * rear, 0, 0))
                key(arm, f'leg_{name}_lo', f, rot=(62 * rear, 0, 0))
            else:                   # hind legs take the weight
                key(arm, f'leg_{name}_up', f, rot=(18 * rear, 0, 0))
                key(arm, f'leg_{name}_lo', f, rot=(-22 * rear, 0, 0))
        for i, b in enumerate(['tail_01', 'tail_02', 'tail_03', 'tail_04']):
            key(arm, b, f, rot=(-6 - 10 * rear, 0, 4 * math.sin(2 * math.pi * (t - 0.2 * i))))
    return act, 0, N


def clip_squeeze(arm):
    """Through the crack. The only pose that sells the hole as a hole.
    ★ IN PLACE — the lateral compression TRAVELS along the spine while the root
    stays put; the controller moves the body through the opening. A clip that
    translated here would be root motion fighting the route."""
    act = new_action(arm, 'squeeze')
    clear_pose(arm)
    N = 36                      # 0.6 s, one-shot
    chain = ['head', 'neck', 'spine_02', 'spine_01']
    for f in range(N + 1):
        t = f / N
        for i, b in enumerate(chain):
            # each segment compresses as the wave passes it, nose first
            local = min(1.0, max(0.0, (t - 0.13 * i) / 0.34))
            w = math.sin(math.pi * local) if local > 0 else 0.0
            key(arm, b, f, scale=(1 - 0.42 * w, 1, 1 - 0.14 * w),
                rot=(0, 0, 5 * w * (1 if i % 2 else -1)))
        for (name, _, _) in LEGS:
            spread = math.sin(math.pi * min(1.0, t / 0.9))
            key(arm, f'leg_{name}_up', f, rot=(30 * spread, 0, 0))
            key(arm, f'leg_{name}_lo', f, rot=(-40 * spread, 0, 0))
        for i, b in enumerate(['tail_01', 'tail_02', 'tail_03', 'tail_04']):
            wave = math.sin(math.pi * min(1.0, max(0.0, (t - 0.55 - 0.08 * i) / 0.4)))
            key(arm, b, f, rot=(-4, 0, 16 * wave))
    return act, 0, N


def push_to_nla(arm, entries):
    """Every action gets its own NLA track. The exporter walks tracks, so an
    action that is only fake-user'd can silently fail to appear as a glTF
    animation — and an export with four clips missing still reports success."""
    ad = arm.animation_data
    ad.action = None
    for (act, start, end) in entries:
        tr = ad.nla_tracks.new()
        tr.name = act.name
        st = tr.strips.new(act.name, int(start), act)
        st.frame_end = float(end)
        tr.mute = True


# ── the crack assert ───────────────────────────────────────────────────────
CRACK_W, CRACK_H = 0.075, 0.135


def squeeze_fits(arm, body, act):
    """Evaluate the mesh at the tightest frame of `squeeze` and measure its real
    cross-section. The opening is 0.075 x 0.135; the pose has to go through it."""
    ad = arm.animation_data
    ad.action = act
    try:
        if act.slots:
            ad.action_slot = act.slots[0]
    except Exception:
        pass
    dg = bpy.context.evaluated_depsgraph_get()
    worst = None
    for f in range(0, 37):
        bpy.context.scene.frame_set(f)
        dg.update()
        ev = body.evaluated_get(dg)
        me = ev.to_mesh()
        xs = [v.co.x for v in me.vertices]
        zs = [v.co.z for v in me.vertices]
        w, h = max(xs) - min(xs), max(zs) - min(zs)
        if worst is None or w < worst[1]:
            worst = (f, w, h)
        ev.to_mesh_clear()
    ad.action = None
    return worst


def main():
    clear_scene()
    body, dark = build_mesh()
    build_materials(body, dark)
    arm = build_armature(body, dark)

    entries = [clip_scurry(arm), clip_freeze(arm), clip_sniff(arm), clip_squeeze(arm)]
    names = [e[0].name for e in entries]
    assert names == ['scurry', 'freeze', 'sniff', 'squeeze'], names

    sq = [e for e in entries if e[0].name == 'squeeze'][0]
    frame, w, h = squeeze_fits(arm, body, sq[0])
    print(f'[mouse] squeeze tightest at frame {frame}: {w*1000:.1f} x {h*1000:.1f} mm '
          f'through a {CRACK_W*1000:.0f} x {CRACK_H*1000:.0f} mm crack')
    assert w < CRACK_W and h < CRACK_H, \
        f'squeeze pose {w:.4f} x {h:.4f} does not fit the crack {CRACK_W} x {CRACK_H}'

    push_to_nla(arm, entries)
    bpy.context.scene.frame_set(0)

    # bounds, measured not assumed — a wrong export scale reads as ~45 or ~0.005
    dg = bpy.context.evaluated_depsgraph_get()
    ev = body.evaluated_get(dg)
    me = ev.to_mesh()
    xs = [v.co.x for v in me.vertices]
    ys = [v.co.y for v in me.vertices]
    zs = [v.co.z for v in me.vertices]
    dims = (max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs))
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    ev.to_mesh_clear()
    print(f'[mouse] bounds {dims[0]*1000:.1f} x {dims[1]*1000:.1f} x {dims[2]*1000:.1f} mm, '
          f'{tris} tris, {len(arm.data.bones)} bones')

    if os.path.isdir(BLEND_DIR):
        bpy.ops.wm.save_as_mainfile(filepath=BLEND_OUT)
        print(f'[mouse] blend -> {BLEND_OUT}')
    else:
        print(f'[mouse] WARNING: {BLEND_DIR} not mounted, .blend not saved')

    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(
        filepath=GLB_OUT,
        export_format='GLB',
        export_yup=True,
        use_selection=True,
        export_apply=True,              # subsurf must be applied; nothing procedural survives
        export_animation_mode='ACTIONS',
        export_nla_strips=True,
        export_bake_animation=False,
        export_image_format='NONE',     # there are no textures, by design
        export_materials='EXPORT',
        export_skins=True,
        export_def_bones=False,
    )
    print(f'[mouse] glb  -> {GLB_OUT} ({os.path.getsize(GLB_OUT)/1024:.1f} KB)')


main()
