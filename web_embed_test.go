package main

import (
	"encoding/json"
	"io/fs"
	"path"
	"regexp"
	"strings"
	"testing"
)

// The //go:embed directive restates the contents of web/ by hand, so a file
// added to the app and not to the directive is served as a 404 by a binary that
// built and vetted cleanly. These tests read the assets the page actually
// references and require each one to be in the embedded set.

const manifestPath = "web/manifest.webmanifest"

var (
	jsImport  = regexp.MustCompile(`(?:from|import)\s*\(?\s*'(\.[^']*)'`)
	htmlAsset = regexp.MustCompile(`(?:href|src)="/([^"]+)"`)
)

type webManifest struct {
	Icons []struct {
		Src string `json:"src"`
	} `json:"icons"`
	ShareTarget struct {
		Action string `json:"action"`
		Method string `json:"method"`
	} `json:"share_target"`
	FileHandlers []struct {
		Action string `json:"action"`
	} `json:"file_handlers"`
}

func readManifest(t *testing.T) webManifest {
	t.Helper()
	raw, err := webFS.ReadFile(manifestPath)
	if err != nil {
		t.Fatalf("the manifest is not embedded: %v", err)
	}
	var m webManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("the manifest is not valid JSON: %v", err)
	}
	return m
}

func mustBeEmbedded(t *testing.T, name, why string) {
	t.Helper()
	if _, err := webFS.Open(name); err != nil {
		t.Errorf("%s is referenced by %s but is not embedded, so it would be served as a 404", name, why)
	}
}

func TestEveryReferencedWebAssetIsEmbedded(t *testing.T) {
	// Every relative import in every embedded script, resolved against the
	// importer. This is what catches a module that was written and wired up but
	// never added to the directive.
	err := fs.WalkDir(webFS, "web", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".js") {
			return err
		}
		src, err := webFS.ReadFile(p)
		if err != nil {
			return err
		}
		for _, m := range jsImport.FindAllStringSubmatch(string(src), -1) {
			mustBeEmbedded(t, path.Join(path.Dir(p), m[1]), p)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	index, err := webFS.ReadFile("web/index.html")
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range htmlAsset.FindAllStringSubmatch(string(index), -1) {
		mustBeEmbedded(t, "web/"+m[1], "web/index.html")
	}

	man := readManifest(t)
	if len(man.Icons) == 0 {
		t.Fatal("the manifest declares no icons, so no install prompt is offered")
	}
	for _, icon := range man.Icons {
		mustBeEmbedded(t, "web/"+strings.TrimPrefix(icon.Src, "/"), manifestPath)
	}
}

// The manifest names the two URLs the operating system launches this app on.
// One is answered by the server and one by the service worker, and neither
// knows the manifest exists, so the names are checked against their handlers
// here rather than left to agree by memory.
func TestManifestLaunchTargetsHaveHandlers(t *testing.T) {
	man := readManifest(t)
	if len(man.FileHandlers) != 1 {
		t.Fatalf("want exactly one file handler, got %d", len(man.FileHandlers))
	}

	s, _ := newTestServer(t, true)
	action := man.FileHandlers[0].Action
	if body := do(t, s, "GET", action, "").Body.String(); body != "<h1>hi</h1>" {
		t.Errorf("the manifest launches file handlers at %s, but the server answered %q there instead of the app", action, body)
	}

	// The share POST carries the plaintext the whole design exists to keep from
	// the server, so it must be intercepted before it reaches the network. The
	// worker is the only thing that can do that.
	sw, err := webFS.ReadFile("web/sw.js")
	if err != nil {
		t.Fatal(err)
	}
	share := man.ShareTarget.Action
	if !strings.Contains(string(sw), "'"+share+"'") && !strings.Contains(string(sw), `"`+share+`"`) {
		t.Errorf("the manifest posts shares to %s, but web/sw.js does not intercept that path, so the plaintext would be sent to the server", share)
	}
	if man.ShareTarget.Method != "POST" {
		t.Errorf("share_target method = %q, want POST; a GET share would put the payload in a URL", man.ShareTarget.Method)
	}
}

// The share POST is the one entry point that does not reach the mux, so the
// gate's cross-site check never runs on it. A service worker intercepts an
// in-scope navigation whoever started it, which means a hostile page can post a
// payload of its choosing to /share and land the browser back on the app. What
// keeps that from becoming an upload is that every launch path stages, and only
// a press of Send uploads. Uploading on arrival instead is a one-line change
// that reads like a convenience, so the shape is pinned here.
//
// The Windows file handler is held to the same rule for a different reason: a
// launch names files but not a destination, and picking the destination is the
// product.
func TestEveryLaunchPathStagesRatherThanUploads(t *testing.T) {
	app, err := webFS.ReadFile("web/app.js")
	if err != nil {
		t.Fatal(err)
	}
	send, err := webFS.ReadFile("web/views/send.js")
	if err != nil {
		t.Fatal(err)
	}

	for _, fn := range []string{"stageFiles", "stageText"} {
		if !strings.Contains(string(send), "export function "+fn) {
			t.Errorf("web/views/send.js does not export %s, so a launch path has no staging list to reach", fn)
		}
		if !strings.Contains(string(app), fn) {
			t.Errorf("web/app.js never names %s, so something it was handed reaches the network unstaged or not at all", fn)
		}
	}

	// The upload loop stays unexported, so no launch path can reach it even by
	// importing it directly. This is what makes the rule above structural rather
	// than a convention app.js has to remember.
	if regexp.MustCompile(`export\s+(?:async\s+)?function\s+send`).Match(send) {
		t.Error("web/views/send.js exports a send function, so a launch path can upload without a staged confirmation")
	}
}
