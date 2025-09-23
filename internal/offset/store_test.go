package offset

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestStore(t *testing.T) {
	dir := t.TempDir()
	name := filepath.Join(dir, "store.chk")

	store := NewFileStore(name)

	checkpoint, err := store.Load()
	assert.NoError(t, err)

	now := time.Now()
	ok := now.After(checkpoint)
	assert.True(t, ok)

	err = store.Save(now)
	assert.NoError(t, err)

	checkpoint, err = store.Load()
	assert.NoError(t, err)
	assert.Equal(t, now.Format(time.RFC3339), checkpoint.Format(time.RFC3339))

	err = os.Remove(name)
	assert.NoError(t, err)
}
