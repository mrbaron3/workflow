package control

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
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

func latestDashboardBootstrapURLFromLogs(t *testing.T, logs string) string {
	t.Helper()
	latest := ""
	for _, line := range strings.Split(logs, "\n") {
		var event struct {
			DashboardBootstrapURL string `json:"dashboardBootstrapUrl"`
		}
		if json.Unmarshal([]byte(line), &event) == nil &&
			event.DashboardBootstrapURL != "" {
			latest = event.DashboardBootstrapURL
		}
	}
	if latest == "" {
		t.Fatal("dashboard bootstrap URL was not logged")
	}
	return latest
}

type reorderedBootstrapLogHandler struct {
	calls         atomic.Int32
	firstEntered  chan struct{}
	secondEntered chan struct{}
	releaseFirst  chan struct{}
	mu            sync.Mutex
	urls          []string
}

func newReorderedBootstrapLogHandler() *reorderedBootstrapLogHandler {
	return &reorderedBootstrapLogHandler{
		firstEntered:  make(chan struct{}),
		secondEntered: make(chan struct{}),
		releaseFirst:  make(chan struct{}),
	}
}

func (handler *reorderedBootstrapLogHandler) Enabled(
	context.Context,
	slog.Level,
) bool {
	return true
}

func (handler *reorderedBootstrapLogHandler) Handle(
	_ context.Context,
	record slog.Record,
) error {
	target := ""
	record.Attrs(func(attribute slog.Attr) bool {
		if attribute.Key == "dashboardBootstrapUrl" {
			target = attribute.Value.String()
		}
		return true
	})
	call := handler.calls.Add(1)
	if call == 1 {
		close(handler.firstEntered)
		<-handler.releaseFirst
	}
	handler.mu.Lock()
	handler.urls = append(handler.urls, target)
	handler.mu.Unlock()
	if call == 2 {
		close(handler.secondEntered)
	}
	return nil
}

func (handler *reorderedBootstrapLogHandler) WithAttrs(
	[]slog.Attr,
) slog.Handler {
	return handler
}

func (handler *reorderedBootstrapLogHandler) WithGroup(string) slog.Handler {
	return handler
}

func (handler *reorderedBootstrapLogHandler) URLs() []string {
	handler.mu.Lock()
	defer handler.mu.Unlock()
	return append([]string(nil), handler.urls...)
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
	events := strings.Join(store.auditEvents, ",")
	for _, required := range []string{
		"browser.session.created",
		"browser.session.rejected",
		"browser.session.logout",
	} {
		if !strings.Contains(events, required) {
			t.Fatalf("browser audit events %q missing %q", events, required)
		}
	}
	details, err := json.Marshal(store.auditDetails)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{
		"one-time-bootstrap-token",
		session.CSRFToken,
		sessionCookie.Value,
	} {
		if bytes.Contains(details, []byte(secret)) {
			t.Fatalf("browser audit exposed secret %q: %s", secret, details)
		}
	}
}

func TestBrowserBootstrapReusesValidSessionWithoutConsumingNextToken(t *testing.T) {
	var logs bytes.Buffer
	api := browserTestAPI(&fakeAPIStore{})
	api.Log = slog.New(slog.NewJSONHandler(&logs, nil))
	handler := api.Handler()

	bootstrap := func(target string, cookie *http.Cookie) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodGet, target, nil)
		request.Host = "127.0.0.1:8080"
		request.RemoteAddr = "127.0.0.1:40000"
		if cookie != nil {
			request.AddCookie(cookie)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}

	initialURL := "http://127.0.0.1:8080/dashboard/bootstrap?" +
		"token=one-time-bootstrap-token-with-enough-entropy"
	response := bootstrap(initialURL, nil)
	if response.Code != http.StatusSeeOther ||
		len(response.Result().Cookies()) != 1 {
		t.Fatalf(
			"initial bootstrap status=%d cookies=%#v body=%s",
			response.Code,
			response.Result().Cookies(),
			response.Body,
		)
	}
	sessionCookie := response.Result().Cookies()[0]

	rotatedURL := latestDashboardBootstrapURLFromLogs(t, logs.String())
	parsed, err := url.Parse(rotatedURL)
	if err != nil ||
		parsed.Query().Get("token") == "" ||
		parsed.Query().Get("token") ==
			"one-time-bootstrap-token-with-enough-entropy" {
		t.Fatalf("rotated bootstrap URL was not logged: %q", rotatedURL)
	}

	response = bootstrap(rotatedURL, sessionCookie)
	if response.Code != http.StatusSeeOther ||
		response.Header().Get("Location") != "/" ||
		len(response.Result().Cookies()) != 0 {
		t.Fatalf(
			"existing session bootstrap status=%d headers=%v cookies=%#v",
			response.Code,
			response.Header(),
			response.Result().Cookies(),
		)
	}

	// The authenticated visit above must not consume the current token. A
	// browser without the session can still use the same URL exactly once.
	response = bootstrap(rotatedURL, nil)
	if response.Code != http.StatusSeeOther ||
		len(response.Result().Cookies()) != 1 {
		t.Fatalf(
			"unconsumed bootstrap status=%d cookies=%#v body=%s",
			response.Code,
			response.Result().Cookies(),
			response.Body,
		)
	}
	response = bootstrap(rotatedURL, nil)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("reused rotated bootstrap status = %d", response.Code)
	}
}

func TestBrowserBootstrapReestablishesExpiredSessionWithCurrentToken(t *testing.T) {
	var logs bytes.Buffer
	store := &fakeAPIStore{}
	api := browserTestAPI(store)
	api.SessionTTL = time.Millisecond
	api.Log = slog.New(slog.NewJSONHandler(&logs, nil))
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
	if response.Code != http.StatusSeeOther ||
		len(response.Result().Cookies()) != 1 {
		t.Fatalf("initial bootstrap = %d cookies=%#v", response.Code, response.Result().Cookies())
	}
	expiredCookie := response.Result().Cookies()[0]
	currentURL := latestDashboardBootstrapURLFromLogs(t, logs.String())

	time.Sleep(5 * time.Millisecond)
	request = httptest.NewRequest(http.MethodGet, currentURL, nil)
	request.Host = "127.0.0.1:8080"
	request.RemoteAddr = "127.0.0.1:40000"
	request.AddCookie(expiredCookie)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusSeeOther ||
		len(response.Result().Cookies()) != 1 ||
		response.Result().Cookies()[0].Value == expiredCookie.Value {
		t.Fatalf(
			"expired session bootstrap = %d cookies=%#v body=%s",
			response.Code,
			response.Result().Cookies(),
			response.Body,
		)
	}
	if !strings.Contains(
		strings.Join(store.auditEvents, ","),
		"browser.session.expired",
	) {
		t.Fatalf("expiry audit events = %#v", store.auditEvents)
	}

	// The current token was consumed by the replacement session.
	request = httptest.NewRequest(http.MethodGet, currentURL, nil)
	request.Host = "127.0.0.1:8080"
	request.RemoteAddr = "127.0.0.1:40000"
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("reused replacement bootstrap status = %d", response.Code)
	}
}

func TestConcurrentBootstrapRotationsLogTheCurrentTokenLast(t *testing.T) {
	api := browserTestAPI(&fakeAPIStore{})
	if err := api.Initialize(); err != nil {
		t.Fatal(err)
	}
	logHandler := newReorderedBootstrapLogHandler()
	api.Log = slog.New(logHandler)

	firstDone := make(chan struct{})
	go func() {
		api.rotateBootstrap("first")
		close(firstDone)
	}()
	select {
	case <-logHandler.firstEntered:
	case <-time.After(time.Second):
		t.Fatal("first rotation did not reach the logger")
	}

	secondDone := make(chan struct{})
	go func() {
		api.rotateBootstrap("second")
		close(secondDone)
	}()
	// Without API-level serialization, the second rotation reaches the
	// logger while the first is blocked and makes the final log entry stale.
	select {
	case <-logHandler.secondEntered:
	case <-time.After(100 * time.Millisecond):
	}
	close(logHandler.releaseFirst)

	for name, done := range map[string]<-chan struct{}{
		"first":  firstDone,
		"second": secondDone,
	} {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatalf("%s rotation did not finish", name)
		}
	}
	urls := logHandler.URLs()
	if len(urls) != 2 {
		t.Fatalf("rotation URLs = %#v", urls)
	}
	latest, err := url.Parse(urls[len(urls)-1])
	if err != nil {
		t.Fatal(err)
	}
	if _, err := api.sessions.bootstrap(latest.Query().Get("token")); err != nil {
		t.Fatalf("latest logged bootstrap token is not current: %v", err)
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
	store := &fakeAPIStore{}
	api := browserTestAPI(store)
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
	if !strings.Contains(strings.Join(store.auditEvents, ","), "browser.session.expired") {
		t.Fatalf("expiry audit events = %#v", store.auditEvents)
	}
}

func TestBrowserSessionCreationFailsClosedWhenAuditIsUnavailable(t *testing.T) {
	store := &fakeAPIStore{auditError: ErrStoreUnavailable}
	handler := browserTestAPI(store).Handler()
	request := httptest.NewRequest(
		http.MethodGet,
		"http://127.0.0.1:8080/dashboard/bootstrap?token=one-time-bootstrap-token-with-enough-entropy",
		nil,
	)
	request.Host = "127.0.0.1:8080"
	request.RemoteAddr = "127.0.0.1:40000"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable ||
		len(response.Result().Cookies()) != 0 {
		t.Fatalf("audit failure bootstrap status=%d cookies=%#v body=%s", response.Code, response.Result().Cookies(), response.Body)
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
