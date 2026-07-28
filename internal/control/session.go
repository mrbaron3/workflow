package control

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const browserSessionCookie = "agentops_session"

type browserSession struct {
	ID        string
	CSRF      string
	ExpiresAt time.Time
}

type browserSessions struct {
	mu                 sync.Mutex
	ttl                time.Duration
	bootstrapHash      [32]byte
	bootstrapUsed      bool
	bootstrapExpiresAt time.Time
	items              map[string]browserSession
}

func newBrowserSessions(token string, ttl time.Duration) *browserSessions {
	if ttl <= 0 {
		ttl = 8 * time.Hour
	}
	return &browserSessions{
		ttl:                ttl,
		bootstrapHash:      sha256.Sum256([]byte(token)),
		bootstrapExpiresAt: time.Now().UTC().Add(10 * time.Minute),
		items:              make(map[string]browserSession),
	}
}

func (sessions *browserSessions) bootstrap(token string) (browserSession, error) {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	provided := sha256.Sum256([]byte(token))
	if sessions.bootstrapUsed ||
		!sessions.bootstrapExpiresAt.After(time.Now().UTC()) ||
		!hmac.Equal(provided[:], sessions.bootstrapHash[:]) {
		return browserSession{}, fmt.Errorf("bootstrap token is invalid or already used")
	}
	session, err := sessions.newSessionLocked()
	if err != nil {
		return browserSession{}, err
	}
	sessions.bootstrapUsed = true
	sessions.items[session.ID] = session
	return session, nil
}

func (sessions *browserSessions) get(request *http.Request) (browserSession, bool, bool) {
	cookie, err := request.Cookie(browserSessionCookie)
	if err != nil || cookie.Value == "" {
		return browserSession{}, false, false
	}
	now := time.Now().UTC()
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	session, present := sessions.items[cookie.Value]
	if !present {
		return browserSession{}, false, false
	}
	if !session.ExpiresAt.After(now) {
		delete(sessions.items, cookie.Value)
		return browserSession{}, false, true
	}
	return session, true, false
}

func (sessions *browserSessions) delete(id string) {
	sessions.mu.Lock()
	delete(sessions.items, id)
	sessions.mu.Unlock()
}

func (sessions *browserSessions) rotateBootstrap() (string, error) {
	token, err := randomOpaque(32)
	if err != nil {
		return "", err
	}
	sessions.mu.Lock()
	sessions.bootstrapHash = sha256.Sum256([]byte(token))
	sessions.bootstrapUsed = false
	sessions.bootstrapExpiresAt = time.Now().UTC().Add(10 * time.Minute)
	sessions.mu.Unlock()
	return token, nil
}

func (sessions *browserSessions) newSessionLocked() (browserSession, error) {
	id, err := randomOpaque(32)
	if err != nil {
		return browserSession{}, err
	}
	csrf, err := randomOpaque(32)
	if err != nil {
		return browserSession{}, err
	}
	return browserSession{
		ID:        id,
		CSRF:      csrf,
		ExpiresAt: time.Now().UTC().Add(sessions.ttl),
	}, nil
}

func randomOpaque(size int) (string, error) {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func validateCanonicalOrigin(raw string) (*url.URL, error) {
	origin, err := url.Parse(raw)
	if err != nil || origin.Scheme == "" || origin.Host == "" ||
		origin.User != nil || origin.Path != "" || origin.RawQuery != "" ||
		origin.Fragment != "" {
		return nil, fmt.Errorf("dashboard origin must be an exact origin")
	}
	if origin.Scheme != "http" && origin.Scheme != "https" {
		return nil, fmt.Errorf("dashboard origin must use http or https")
	}
	host := origin.Hostname()
	address := net.ParseIP(host)
	if address == nil || !address.IsLoopback() || host != "127.0.0.1" {
		return nil, fmt.Errorf("dashboard origin must use the IPv4 loopback address")
	}
	if origin.Port() == "" {
		return nil, fmt.Errorf("dashboard origin must include an explicit port")
	}
	port, err := strconv.Atoi(origin.Port())
	if err != nil || port < 1 || port > 65535 {
		return nil, fmt.Errorf("dashboard origin must include a valid explicit port")
	}
	return origin, nil
}

func requestIsLoopback(request *http.Request) bool {
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		host = request.RemoteAddr
	}
	address := net.ParseIP(strings.Trim(host, "[]"))
	return address != nil && address.IsLoopback()
}

func setSessionCookie(writer http.ResponseWriter, origin *url.URL, session browserSession) {
	http.SetCookie(writer, &http.Cookie{
		Name:     browserSessionCookie,
		Value:    session.ID,
		Path:     "/",
		HttpOnly: true,
		Secure:   origin.Scheme == "https",
		SameSite: http.SameSiteStrictMode,
		Expires:  session.ExpiresAt,
		MaxAge:   int(time.Until(session.ExpiresAt).Seconds()),
	})
}

func expireSessionCookie(writer http.ResponseWriter, origin *url.URL) {
	http.SetCookie(writer, &http.Cookie{
		Name:     browserSessionCookie,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   origin.Scheme == "https",
		SameSite: http.SameSiteStrictMode,
		MaxAge:   -1,
	})
}
