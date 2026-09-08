#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CausalMessage<T> {
    pub token: u64,
    pub payload: T,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidCausalToken {
    pub token: u64,
    pub previous: u64,
}
