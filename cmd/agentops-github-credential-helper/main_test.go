package main

import (
	"os"
	"reflect"
	"strconv"
	"testing"
)

func TestPreparePrivateKeyDirectoryUsesOnlyChownCapability(t *testing.T) {
	var calls []string
	err := preparePrivateKeyDirectory(
		"/private-volume",
		func(path string, mode os.FileMode) error {
			calls = append(calls, "mkdir:"+path+":"+mode.String())
			return nil
		},
		func(path string, uid, gid int) error {
			calls = append(
				calls,
				"chown:"+path+":"+strconv.Itoa(uid)+":"+strconv.Itoa(gid),
			)
			return nil
		},
		func(path string, mode os.FileMode) error {
			calls = append(calls, "chmod:"+path+":"+mode.String())
			return nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"mkdir:/private-volume:-rwx------",
		"chown:/private-volume:0:0",
		"chmod:/private-volume:-rwx------",
		"chown:/private-volume:65532:65532",
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls = %#v, want %#v", calls, want)
	}
}
