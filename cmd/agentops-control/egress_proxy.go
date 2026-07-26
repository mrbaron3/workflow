package main

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

func runnerEgressProxy(listenAddress, provider string) (*http.Server, error) {
	if listenAddress == "" {
		return nil, nil
	}
	allowed, err := runnerEgressDestinations(provider)
	if err != nil {
		return nil, err
	}
	handler := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodConnect {
			http.Error(writer, "only HTTPS CONNECT is permitted", http.StatusMethodNotAllowed)
			return
		}
		target := strings.ToLower(strings.TrimSpace(request.Host))
		if !allowed[target] {
			http.Error(writer, "runner egress destination denied", http.StatusForbidden)
			return
		}
		hijacker, ok := writer.(http.Hijacker)
		if !ok {
			http.Error(writer, "proxy tunnel unavailable", http.StatusInternalServerError)
			return
		}
		upstream, err := net.DialTimeout("tcp", target, 10*time.Second)
		if err != nil {
			http.Error(writer, "runner egress destination unavailable", http.StatusBadGateway)
			return
		}
		client, buffer, err := hijacker.Hijack()
		if err != nil {
			_ = upstream.Close()
			return
		}
		if _, err := io.WriteString(
			client,
			"HTTP/1.1 200 Connection Established\r\n\r\n",
		); err != nil {
			_ = client.Close()
			_ = upstream.Close()
			return
		}
		if err := buffer.Flush(); err != nil {
			_ = client.Close()
			_ = upstream.Close()
			return
		}
		go proxyTunnel(client, upstream, buffer.Reader)
	})
	return &http.Server{
		Addr:              listenAddress,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       time.Minute,
	}, nil
}

func runnerEgressDestinations(provider string) (map[string]bool, error) {
	destinations := map[string]bool{
		"github.com:443":     true,
		"api.github.com:443": true,
	}
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "codex":
		destinations["api.openai.com:443"] = true
	case "claude":
		destinations["api.anthropic.com:443"] = true
	default:
		return nil, fmt.Errorf("AGENTOPS_RUNNER_PROVIDER must be codex or claude")
	}
	return destinations, nil
}

func proxyTunnel(client, upstream net.Conn, buffered *bufio.Reader) {
	defer client.Close()
	defer upstream.Close()
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(upstream, io.MultiReader(buffered, client))
		if tcp, ok := upstream.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(client, upstream)
		if tcp, ok := client.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
		done <- struct{}{}
	}()
	<-done
}
