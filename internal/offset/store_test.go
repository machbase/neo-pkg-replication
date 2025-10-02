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

	// `{cursor:"", meta_offset:1, rid:2}`

	store := NewFileStore(name)

	checkpoint, err := store.Load()
	assert.NoError(t, err)

	now := time.Now()
	ok := now.After(checkpoint.Cursor)
	assert.True(t, ok)

	err = store.Save(CheckPoint{Cursor: now, MetaOffset: 11, RID: 22})
	assert.NoError(t, err)

	checkpoint, err = store.Load()
	assert.NoError(t, err)
	assert.Equal(t, now.Format(time.RFC3339), checkpoint.Cursor.Format(time.RFC3339))
	assert.Equal(t, checkpoint.MetaOffset, 11)
	assert.Equal(t, checkpoint.RID, 22)

	err = os.Remove(name)
	assert.NoError(t, err)
}
