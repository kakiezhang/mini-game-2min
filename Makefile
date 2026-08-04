DEV_HOST ?= 0.0.0.0
DEV_PORT ?= 6173
PREVIEW_PORT ?= 6174
CHROMA_INPUT ?= src/assets/raw/player-monkey.png
CHROMA_OUTPUT ?= src/assets/characters/player-monkey.png
CHROMA_KEY ?= 00ff00
CHROMA_TOLERANCE ?= 38
CHROMA_SOFTNESS ?= 48
CHROMA_DESPILL ?= 0.65
PLAYER_ROW_INPUT ?= src/assets/raw/player_rows
PLAYER_FRAME_OUTPUT ?= src/assets/characters/player-human-frames
PLAYER_FRAME_SCALE_MODE ?= normalize-height
PLAYER_FRAME_NORMALIZE_HEIGHT ?= 288

.PHONY: install dev start build preview remove-green build-player-frames

install:
	npm install

dev:
	npm run dev -- --host $(DEV_HOST) --port $(DEV_PORT) --strictPort

start: dev

build:
	npm run build

preview:
	npm run preview -- --host $(DEV_HOST) --port $(PREVIEW_PORT) --strictPort

remove-green:
	npm run remove-green -- --input "$(CHROMA_INPUT)" --output "$(CHROMA_OUTPUT)" --key "$(CHROMA_KEY)" --tolerance "$(CHROMA_TOLERANCE)" --softness "$(CHROMA_SOFTNESS)" --despill "$(CHROMA_DESPILL)"

build-player-frames:
	node scripts/build-character-frames-from-rows.mjs --input-dir "$(PLAYER_ROW_INPUT)" --output-dir "$(PLAYER_FRAME_OUTPUT)" --scale-mode "$(PLAYER_FRAME_SCALE_MODE)" --normalize-height "$(PLAYER_FRAME_NORMALIZE_HEIGHT)"
