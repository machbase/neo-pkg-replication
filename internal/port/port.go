package port

type Source interface {
	// Connect() ()
	Read() ([][]any, error)
	Close() error

	List() // test
}

type Target interface {
	Write([][]any) error
	Close() error
	// Lookup(name string) (config.DBConfig, bool)

	List()
}
