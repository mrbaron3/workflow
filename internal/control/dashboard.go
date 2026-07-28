package control

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed dashboard/*
var dashboardAssets embed.FS

func dashboardHandler() http.Handler {
	content, _ := fs.Sub(dashboardAssets, "dashboard")
	index, _ := fs.ReadFile(content, "index.html")
	files := http.FileServer(http.FS(content))
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet && request.Method != http.MethodHead {
			writeError(writer, http.StatusMethodNotAllowed, "method_not_allowed", "GET is required")
			return
		}
		name := strings.TrimPrefix(path.Clean(request.URL.Path), "/")
		if name == "." || name == "" {
			writer.Header().Set("Content-Type", "text/html; charset=utf-8")
			writer.WriteHeader(http.StatusOK)
			if request.Method != http.MethodHead {
				_, _ = writer.Write(index)
			}
			return
		} else if strings.HasPrefix(name, "assets/") {
			request.URL.Path = "/" + strings.TrimPrefix(name, "assets/")
		}
		files.ServeHTTP(writer, request)
	})
}
