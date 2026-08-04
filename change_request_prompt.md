Generate this enemy as 8 separate row images instead of one full 8-row sheet.

Use each prompt below separately. Choose a 1:1 square image size. Save the 8 outputs with these filenames:

1. row0_down.png
2. row1_down_right.png
3. row2_right.png
4. row3_up_right.png
5. row4_up.png
6. row5_up_left.png
7. row6_left.png
8. row7_down_left.png

After generation, put all 8 files in:

src/assets/raw/enemy_change_request_rows/

Shared character design for all 8 prompts:
A persistent product manager change-request worker, a human-like office stress monster. She is a short-haired female product manager wearing a neat blue shirt uniform, dark office skirt or pants, and an office ID badge labeled "CHANGE". She holds a PRD document in her left hand and a Manner coffee cup in her right hand. The PRD document should look like a thick product requirement document with many sticky notes and revision marks. She should feel pushy, demanding, energetic, and slightly annoying, like she is constantly asking for one more small change, but not scary or bloody.

Important:
This is not an animal and not a fantasy creature. It is a stylized human office worker enemy representing product change requests and scope creep.

Style:
Polished hand-painted mobile game sprite, smooth rounded shapes, clean readable silhouette, exaggerated cartoon office character, high-quality 2.5D game asset. No pixel art, no voxel style, no low-poly facets, no realistic horror, no gore.

Shared canvas rules:
One single horizontal sprite strip on a solid pure green chroma key background (#00ff00). The green background must be flat, uniform, exactly #00ff00, with no gradient, no texture, no glow, and no shadow blending into the background.

Shared layout rules:
Exactly 1 row and exactly 5 columns. Each column must contain exactly one full-body character, centered in its cell, same scale in every cell, no cropping. Do not create multiple rows. Do not create fewer than 5 characters. Do not create more than 5 characters. Do not add grid lines, labels, numbers, UI, text, borders, or separators.

Shared animation columns, from left to right:
1. idle standing pose
2. walk frame 1
3. walk frame 2
4. walk frame 3
5. walk frame 4

Shared animation requirements:
- Walk frames must show confident fast office steps.
- The PRD document in the left hand and the coffee cup in the right hand should move subtly but remain readable.
- The character should stay centered and keep the same size in every frame.
- Keep the feet on the same baseline across all 5 frames.
- Do not add motion blur.
- Do not add shadows that cross cell boundaries.

Shared camera/view:
Orthographic 3/4 top-down game view, matching an isometric-like office action game. The enemy should feel grounded on a tilted top-down office map.

Prompt 1 - row0_down.png:
Create a 2D sprite strip for the shared character design above. Exactly 1 row and 5 columns. All 5 frames face screen down, 180 degrees, walking toward the camera. Front of body visible. Use the shared canvas rules, layout rules, animation columns, animation requirements, style, and camera/view.

Prompt 2 - row1_down_right.png:
Create a 2D sprite strip for the shared character design above. Exactly 1 row and 5 columns. All 5 frames face screen down-right, 135 degrees, walking diagonally toward camera-right. Front-right three-quarter view visible. Use the shared canvas rules, layout rules, animation columns, animation requirements, style, and camera/view.

Prompt 3 - row2_right.png:
Create a 2D sprite strip for the shared character design above. Exactly 1 row and 5 columns. All 5 frames face screen right, 90 degrees, walking to the right side of the screen. Right side profile view visible. Use the shared canvas rules, layout rules, animation columns, animation requirements, style, and camera/view.

Prompt 4 - row3_up_right.png:
Create a 2D sprite strip for the shared character design above. Exactly 1 row and 5 columns. All 5 frames face screen up-right, 45 degrees, walking diagonally away to camera-right. Back-right three-quarter view visible. Use the shared canvas rules, layout rules, animation columns, animation requirements, style, and camera/view.

Prompt 5 - row4_up.png:
Create a 2D sprite strip for the shared character design above. Exactly 1 row and 5 columns. All 5 frames face screen up, 0 degrees, walking away from the camera. Back view visible. Use the shared canvas rules, layout rules, animation columns, animation requirements, style, and camera/view.

Prompt 6 - row5_up_left.png:
Create a 2D sprite strip for the shared character design above. Exactly 1 row and 5 columns. All 5 frames face screen up-left, 315 degrees, walking diagonally away to camera-left. Back-left three-quarter view visible. Use the shared canvas rules, layout rules, animation columns, animation requirements, style, and camera/view.

Prompt 7 - row6_left.png:
Create a 2D sprite strip for the shared character design above. Exactly 1 row and 5 columns. All 5 frames face screen left, 270 degrees, walking to the left side of the screen. Left side profile view visible. Use the shared canvas rules, layout rules, animation columns, animation requirements, style, and camera/view.

Prompt 8 - row7_down_left.png:
Create a 2D sprite strip for the shared character design above. Exactly 1 row and 5 columns. All 5 frames face screen down-left, 225 degrees, walking diagonally toward camera-left. Front-left three-quarter view visible. Use the shared canvas rules, layout rules, animation columns, animation requirements, style, and camera/view.
