package egress

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"
)

// AdminHandler serves tunnel revocation. Bind it to a separate, non-sandbox
// listener; it also needs the bearer token.
//
//	POST /admin/sessions/{session}/close-tunnels -> {"closed": n}
func AdminHandler(reg *Registry, token string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /admin/sessions/{session}/close-tunnels", func(w http.ResponseWriter, r *http.Request) {
		got, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || token == "" || subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		n := reg.CloseSession(r.PathValue("session"))
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]int{"closed": n})
	})
	return mux
}
