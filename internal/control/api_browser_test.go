package control

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func browserTestAPI(store APIStore) *API {
	return &API{
		Store:           store,
		ControlToken:    "control-token",
		WebhookSecret:   "webhook-secret",
		StaleAfter:      time.Minute,
		Mode:            ModeMonitorOnly,
		CanonicalOrigin: "http://127.0.0.1:8080",
		BootstrapToken:  "one-time-bootstrap-token-with-enough-entropy",
		SessionTTL:      time.Hour,
		RouterWake:      func() {},
		Log:             slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

func TestBrowserBootstrapSessionOriginAndCSRFLifecycle(t *testing.T) {
	store := &fakeAPIStore{}
	handler := browserTestAPI(store).Handler()

	request := httptest.NewRequest(
		http.MethodGet,
		"http://127.0.0.1:8080/dashboard/bootstrap?token=one-time-bootstrap-token-with-enough-entropy",
		nil,
	)
	request.Host = "localhost:8080"
	request.RemoteAddr = "127.0.0.1:40000"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("alternate Host bootstrap status = %d", response.Code)
	}

	request = httptest.NewRequest(
		http.MethodGet,
		"http://127.0.0.1:8080/dashboard/bootstrap?token=one-time-bootstrap-token-with-enough-entropy",
		nil,
	)
	request.Host = "127.0.0.1:8080"
	request.RemoteAddr = "127.0.0.1:40000"
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusSeeOther || response.Header().Get("Location") != "/" {
		t.Fatalf("bootstrap = %d headers=%v body=%s", response.Code, response.Header(), response.Body)
	}
	cookies := response.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly ||
		cookies[0].SameSite != http.SameSiteStrictMode ||
		cookies[0].Path != "/" ||
		cookies[0].Value == "" {
		t.Fatalf("session cookie = %#v", cookies)
	}
	sessionCookie := cookies[0]

	request = httptest.NewRequest(
		http.MethodGet,
		"http://127.0.0.1:8080/dashboard/bootstrap?token=one-time-bootstrap-token-with-enough-entropy",
		nil,
	)
	request.Host = "127.0.0.1:8080"
	request.RemoteAddr = "127.0.0.1:40000"
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("reused bootstrap status = %d", response.Code)
	}

	request = httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/v1/browser-session", nil)
	request.Host = "127.0.0.1:8080"
	request.AddCookie(sessionCookie)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("browser session = %d: %s", response.Code, response.Body)
	}
	var session struct {
		CSRFToken string `json:"csrfToken"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &session); err != nil || session.CSRFToken == "" {
		t.Fatalf("session response = %#v error=%v", session, err)
	}

	mutation := func(origin, fetchSite, csrf string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(
			http.MethodPost,
			"http://127.0.0.1:8080/v1/registrations",
			bytes.NewBufferString(`{"repository":"owner/repo"}`),
		)
		request.Host = "127.0.0.1:8080"
		request.AddCookie(sessionCookie)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Idempotency-Key", "browser-create-1")
		request.Header.Set("Origin", origin)
		request.Header.Set("Sec-Fetch-Site", fetchSite)
		request.Header.Set("X-CSRF-Token", csrf)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	for _, test := range []struct {
		name, origin, fetchSite, csrf string
	}{
		{name: "missing origin", fetchSite: "same-origin", csrf: session.CSRFToken},
		{name: "null origin", origin: "null", fetchSite: "same-origin", csrf: session.CSRFToken},
		{name: "alternate origin", origin: "http://localhost:8080", fetchSite: "same-origin", csrf: session.CSRFToken},
		{name: "different scheme", origin: "https://127.0.0.1:8080", fetchSite: "same-origin", csrf: session.CSRFToken},
		{name: "different port", origin: "http://127.0.0.1:8081", fetchSite: "same-origin", csrf: session.CSRFToken},
		{name: "prefix variant", origin: "http://user@127.0.0.1:8080", fetchSite: "same-origin", csrf: session.CSRFToken},
		{name: "suffix variant", origin: "http://127.0.0.1:8080.evil", fetchSite: "same-origin", csrf: session.CSRFToken},
		{name: "missing fetch site", origin: "http://127.0.0.1:8080", csrf: session.CSRFToken},
		{name: "cross site", origin: "http://127.0.0.1:8080", fetchSite: "cross-site", csrf: session.CSRFToken},
		{name: "missing csrf", origin: "http://127.0.0.1:8080", fetchSite: "same-origin"},
		{name: "mismatched csrf", origin: "http://127.0.0.1:8080", fetchSite: "same-origin", csrf: "wrong"},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := mutation(test.origin, test.fetchSite, test.csrf)
			if response.Code != http.StatusForbidden || store.creates != 0 {
				t.Fatalf("status=%d creates=%d body=%s", response.Code, store.creates, response.Body)
			}
		})
	}
	response = mutation("http://127.0.0.1:8080", "same-origin", session.CSRFToken)
	if response.Code != http.StatusCreated || store.creates != 1 {
		t.Fatalf("same-origin mutation = %d creates=%d body=%s", response.Code, store.creates, response.Body)
	}

	request = httptest.NewRequest(http.MethodDelete, "http://127.0.0.1:8080/v1/browser-session", nil)
	request.Host = "127.0.0.1:8080"
	request.AddCookie(sessionCookie)
	request.Header.Set("Origin", "http://127.0.0.1:8080")
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	request.Header.Set("X-CSRF-Token", session.CSRFToken)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("logout = %d: %s", response.Code, response.Body)
	}
	request = httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/v1/browser-session", nil)
	request.Host = "127.0.0.1:8080"
	request.AddCookie(sessionCookie)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("logged-out session status = %d", response.Code)
	}
}

func TestOperatorAPIRejectsAlternateHostEvenWithBearer(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "http://localhost:8080/v1/registrations", nil)
	request.Host = "localhost:8080"
	request.Header.Set("Authorization", "Bearer control-token")
	response := httptest.NewRecorder()
	browserTestAPI(&fakeAPIStore{}).Handler().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("alternate operator Host status = %d body=%s", response.Code, response.Body)
	}
}

func TestExpiredBrowserSessionFailsClosed(t *testing.T) {
	api := browserTestAPI(&fakeAPIStore{})
	api.SessionTTL = time.Millisecond
	handler := api.Handler()
	request := httptest.NewRequest(
		http.MethodGet,
		"http://127.0.0.1:8080/dashboard/bootstrap?token=one-time-bootstrap-token-with-enough-entropy",
		nil,
	)
	request.Host = "127.0.0.1:8080"
	request.RemoteAddr = "127.0.0.1:40000"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	cookie := response.Result().Cookies()[0]
	time.Sleep(5 * time.Millisecond)
	request = httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/v1/browser-session", nil)
	request.Host = "127.0.0.1:8080"
	request.AddCookie(cookie)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("expired session status = %d body=%s", response.Code, response.Body)
	}
}

func TestBrowserBootstrapRotationKeepsEveryTokenSingleUse(t *testing.T) {
	sessions := newBrowserSessions(
		"initial-bootstrap-token-with-enough-entropy",
		time.Hour,
	)
	if _, err := sessions.bootstrap("initial-bootstrap-token-with-enough-entropy"); err != nil {
		t.Fatal(err)
	}
	rotated, err := sessions.rotateBootstrap()
	if err != nil {
		t.Fatal(err)
	}
	if rotated == "initial-bootstrap-token-with-enough-entropy" || len(rotated) < 32 {
		t.Fatalf("rotated bootstrap = %q", rotated)
	}
	if _, err := sessions.bootstrap("initial-bootstrap-token-with-enough-entropy"); err == nil {
		t.Fatal("superseded bootstrap token was accepted")
	}
	if _, err := sessions.bootstrap(rotated); err != nil {
		t.Fatal(err)
	}
	if _, err := sessions.bootstrap(rotated); err == nil {
		t.Fatal("rotated bootstrap token was reusable")
	}
}

func TestDashboardAssetsAreSessionBoundAndBearerFree(t *testing.T) {
	api := browserTestAPI(&fakeAPIStore{})
	handler := api.Handler()
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/", nil)
	request.Host = "127.0.0.1:8080"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated dashboard status = %d", response.Code)
	}
	if !strings.Contains(response.Header().Get("Content-Security-Policy"), "connect-src 'self'") ||
		response.Header().Get("Referrer-Policy") != "no-referrer" ||
		response.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("security headers = %#v", response.Header())
	}

	bootstrap := httptest.NewRequest(
		http.MethodGet,
		"http://127.0.0.1:8080/dashboard/bootstrap?token=one-time-bootstrap-token-with-enough-entropy",
		nil,
	)
	bootstrap.Host = "127.0.0.1:8080"
	bootstrap.RemoteAddr = "127.0.0.1:40000"
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, bootstrap)
	cookie := response.Result().Cookies()[0]

	for _, target := range []string{"/", "/assets/dashboard.js", "/assets/dashboard.css"} {
		request = httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080"+target, nil)
		request.Host = "127.0.0.1:8080"
		request.AddCookie(cookie)
		response = httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("%s status = %d: %s", target, response.Code, response.Body)
		}
		if bytes.Contains(response.Body.Bytes(), []byte("control-token")) ||
			bytes.Contains(response.Body.Bytes(), []byte("Bearer ")) ||
			bytes.Contains(response.Body.Bytes(), []byte("one-time-bootstrap-token")) {
			t.Fatalf("%s exposed a bearer/bootstrap secret", target)
		}
	}
}

func TestOperatorCommandsRejectUnknownExecutionInputs(t *testing.T) {
	store := &fakeAPIStore{}
	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/registrations",
		bytes.NewBufferString(`{"repository":"owner/repo","configuration":{"command":"sh"},"mount":"/Users"}`),
	)
	request.Header.Set("Authorization", "Bearer control-token")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", "strict-command-1")
	response := httptest.NewRecorder()
	testAPI(store).Handler().ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || store.creates != 0 {
		t.Fatalf("unsafe input = %d creates=%d body=%s", response.Code, store.creates, response.Body)
	}
}
