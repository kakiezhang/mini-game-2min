DEV_HOST ?= 127.0.0.1
DEV_PORT ?= 6173
PREVIEW_PORT ?= 6174

.PHONY: install dev start build preview

install:
	npm install

dev:
	npm run dev -- --host $(DEV_HOST) --port $(DEV_PORT) --strictPort

start: dev

build:
	npm run build

preview:
	npm run preview -- --host $(DEV_HOST) --port $(PREVIEW_PORT) --strictPort
